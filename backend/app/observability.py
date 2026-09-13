"""Structured logs, liveness/readiness, and Prometheus metrics.

The difference between a service that runs and a service that can be operated
is mostly here: something has to be able to ask the process whether it is
alive, whether it is ready to take traffic, and what it has been doing --
without a human reading a terminal.

* `/health`  liveness. Cheap, and true as long as the process is up. A
             container orchestrator restarts the pod when this stops
             answering.
* `/ready`   readiness. False until the baseline model has fitted and the
             tick loop is running, so a load balancer does not send traffic
             to an instance that would answer with an empty simulation.
* `/metrics` Prometheus text exposition, so the simulation's own counters are
             scrapeable alongside process metrics.

Logs are JSON lines with a request id, because the first thing anyone does
with production logs is grep them by request.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import Callable, Iterable
from contextvars import ContextVar

#: Set per request by `RequestIdMiddleware`, so every log line emitted while
#: handling a request can be tied back to it.
request_id_var: ContextVar[str] = ContextVar("request_id", default="")

PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"


# ------------------------------------------------------------------- logging
class JsonLogFormatter(logging.Formatter):
    """One JSON object per line -- parseable by anything that ingests logs."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created))
            + f".{int(record.msecs):03d}Z",
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        rid = request_id_var.get()
        if rid:
            payload["request_id"] = rid
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        for key, value in getattr(record, "extra_fields", {}).items():
            payload[key] = value
        return json.dumps(payload)


def configure_logging(level: int = logging.INFO) -> None:
    """Replace the root handler with a JSON one. Idempotent."""
    handler = logging.StreamHandler()
    handler.setFormatter(JsonLogFormatter())
    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level)


# ------------------------------------------------------------------ metrics
def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _sample(name: str, value: float, labels: dict[str, str] | None = None) -> str:
    if labels:
        rendered = ",".join(f'{k}="{_escape(v)}"' for k, v in sorted(labels.items()))
        return f"{name}{{{rendered}}} {value}"
    return f"{name} {value}"


def metric(
    name: str,
    help_text: str,
    kind: str,
    samples: Iterable[tuple[float, dict[str, str] | None]],
) -> list[str]:
    lines = [f"# HELP {name} {help_text}", f"# TYPE {name} {kind}"]
    lines.extend(_sample(name, value, labels) for value, labels in samples)
    return lines


def render_prometheus(state: dict, websocket_clients: int = 0) -> str:
    """Render one state snapshot as Prometheus text exposition."""
    comms = state["metrics"]["communication"]
    detection = state["metrics"]["detection"]
    resilience = state["metrics"]["resilience"]
    traffic = state["metrics"]["traffic"]

    lines: list[str] = []
    lines += metric(
        "v2x_simulation_ticks_total", "Simulation ticks executed.", "counter",
        [(state["tick"], None)],
    )
    lines += metric(
        "v2x_vehicles", "Vehicles currently in the simulation.", "gauge",
        [(len(state["vehicles"]), None)],
    )
    lines += metric(
        "v2x_rsus_alive", "Roadside units currently up.", "gauge",
        [(sum(1 for r in state["rsus"] if r["alive"]), None)],
    )
    lines += metric(
        "v2x_cloud_online", "Whether the cloud uplink is reachable.", "gauge",
        [(1 if state["cloud_online"] else 0, None)],
    )
    lines += metric(
        "v2x_messages_sent_total", "Frames transmitted.", "counter",
        [(comms["messages_sent"], None)],
    )
    lines += metric(
        "v2x_frames_total", "Frames transmitted, by standard designator.", "counter",
        [(count, {"designator": d}) for d, count in comms.get("frames_by_designator", {}).items()],
    )
    lines += metric(
        "v2x_local_kilobytes_total", "Kilobytes over the ITS-G5 sidelink.", "counter",
        [(comms["local_kilobytes"], None)],
    )
    lines += metric(
        "v2x_uplink_kilobytes_total", "Kilobytes over the cloud backhaul.", "counter",
        [(comms["uplink_kilobytes"], None)],
    )
    lines += metric(
        "v2x_packet_delivery_ratio", "Delivered over intended receptions.", "gauge",
        [(comms["packet_delivery_ratio"], None)],
    )
    lines += metric(
        "v2x_hazard_detection", "Hazard detection quality against ground truth.", "gauge",
        [
            (detection["precision"], {"measure": "precision"}),
            (detection["recall"], {"measure": "recall"}),
            (detection["f1"], {"measure": "f1"}),
        ],
    )
    lines += metric(
        "v2x_availability_pct", "Service availability across the run.", "gauge",
        [(resilience["availability_pct"], None)],
    )
    lines += metric(
        "v2x_congestion_duration_pct", "Share of segment samples above threshold.", "gauge",
        [(traffic["congestion_duration_pct"], None)],
    )
    lines += metric(
        "v2x_federated_rounds_total", "Federated averaging rounds completed.", "counter",
        [(state["federated"]["rounds_completed"], None)],
    )
    lines += metric(
        "v2x_websocket_clients", "Dashboards currently attached.", "gauge",
        [(websocket_clients, None)],
    )
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------- middleware
def install_request_id_middleware(app, header: str = "X-Request-ID") -> None:
    """Tag each request with an id, echo it back, and log how it went."""
    logger = logging.getLogger("v2x.access")

    @app.middleware("http")
    async def _request_id(request, call_next: Callable):
        rid = request.headers.get(header) or uuid.uuid4().hex[:16]
        token = request_id_var.set(rid)
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            logger.exception(
                "request failed",
                extra={"extra_fields": {"path": request.url.path, "method": request.method}},
            )
            raise
        finally:
            request_id_var.reset(token)
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        response.headers[header] = rid
        # /metrics is scraped every few seconds; logging it would drown
        # everything else.
        if request.url.path != "/metrics":
            logger.info(
                "request",
                extra={
                    "extra_fields": {
                        "method": request.method,
                        "path": request.url.path,
                        "status": response.status_code,
                        "duration_ms": duration_ms,
                        "request_id": rid,
                    }
                },
            )
        return response
