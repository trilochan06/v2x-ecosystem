"""Design traceability: the deck's architecture, mapped to real code.

Slides 13-15 define a six-layer architecture and twelve modules. A panel
will reasonably ask "where is M7, actually?", so each entry here names the
module that implements it and states honestly what is and isn't built.
"""
from __future__ import annotations

TEAM = {
    "title": "Intelligent Decentralized Vehicle-to-Everything (V2X) Ecosystem",
    "subtitle": "Using Edge Intelligence, Federated Learning and Digital Twin Technology for Intelligent Transportation",
    "course": "B.Tech CSE — Project-I",
    "members": [
        {"name": "Rahul Anand Y", "reg": "23BCE1650"},
        {"name": "Trilochan P", "reg": "23BCE1889"},
        {"name": "Vijay P", "reg": "23BCE5025"},
    ],
    "mentor": "Dr. Malathi",
}

LAYERS = [
    {
        "id": "L6",
        "name": "Applications",
        "components": "Alerts, traffic dashboard, route guidance",
        "function": "Driver and authority interaction, emergency coordination.",
        "implemented_by": ["M9", "M10", "M12"],
    },
    {
        "id": "L5",
        "name": "Digital Twin & Cloud",
        "components": "Digital twin, historical data, analytics",
        "function": "City-wide macroscopic state representation and model management.",
        "implemented_by": ["M8"],
    },
    {
        "id": "L4",
        "name": "Distributed Intelligence",
        "components": "Federated learning, traffic prediction",
        "function": "Regional model aggregation and risk/event analysis.",
        "implemented_by": ["M6", "M7"],
    },
    {
        "id": "L3",
        "name": "Intelligent Edge",
        "components": "RSUs, edge AI, local decision engine",
        "function": "Latency-sensitive inference, caching and traffic aggregation.",
        "implemented_by": ["M4", "M5"],
    },
    {
        "id": "L2",
        "name": "Vehicular Communication",
        "components": "V2V, V2I/V2R, V2N interfaces",
        "function": "Standardized cooperative message exchange.",
        "implemented_by": ["M2", "M11"],
    },
    {
        "id": "L1",
        "name": "Physical / Sensing",
        "components": "Vehicles, GPS/GNSS, road sensors",
        "function": "Telemetry generation and physical environment sensing.",
        "implemented_by": ["M1", "M3"],
    },
]

MODULES = [
    {
        "id": "M1",
        "name": "Vehicle Data Acquisition",
        "description": "Collects mobility and telemetry data (speed, heading, position).",
        "source": "app/simulation/vehicle.py",
        "status": "implemented",
        "notes": "Simulated kinematics on a road graph; real deployments would read CAN bus + GNSS.",
    },
    {
        "id": "M2",
        "name": "V2X Communication Manager",
        "description": "Handles vehicle-to-vehicle and infrastructure messaging protocols.",
        "source": "app/network/gossip.py, app/network/messages.py",
        "status": "implemented",
        "notes": "Hop-limited broadcast with TTL, dedup, and a density-dependent loss model. Models DSRC/C-V2X behaviour rather than the radio PHY itself.",
    },
    {
        "id": "M3",
        "name": "Event & Hazard Detection",
        "description": "Detects abnormal road/vehicle events locally (e.g. hard braking).",
        "source": "app/simulation/vehicle.py",
        "status": "implemented",
        "notes": "Probabilistic on-board sensing of the current and next segment, including sensor false positives.",
    },
    {
        "id": "M4",
        "name": "Intelligent RSU Edge",
        "description": "Aggregates, filters for relevance, and processes local vehicular information.",
        "source": "app/simulation/rsu.py",
        "status": "implemented",
        "notes": "Each RSU runs inference locally and forwards only digests upstream.",
    },
    {
        "id": "M5",
        "name": "Traffic-State Estimation",
        "description": "Turns individual vehicle observations into a road-level traffic state.",
        "source": "app/simulation/rsu.py, app/simulation/world.py",
        "status": "implemented",
        "notes": "Per-segment occupancy with a Greenshields-style speed/density relation.",
    },
    {
        "id": "M6",
        "name": "Predictive Intelligence",
        "description": "Short-horizon congestion and risk prediction at the edge.",
        "source": "app/ai/congestion_model.py",
        "status": "implemented",
        "notes": "Gradient-boosted regressor with per-prediction occlusion attribution for explainability. A GNN is the documented upgrade path.",
    },
    {
        "id": "M7",
        "name": "Federated Learning",
        "description": "Coordinates decentralized model training and regional weight aggregation.",
        "source": "app/ai/federated.py",
        "status": "implemented",
        "notes": "Real FedAvg: RSUs train locally and upload only weights. Sample buffers never leave the client.",
    },
    {
        "id": "M8",
        "name": "Transport Digital Twin",
        "description": "Maintains a synchronized virtual representation of the transportation state.",
        "source": "app/simulation/digital_twin.py",
        "status": "implemented",
        "notes": "Held as a separate replica so synchronization lag and divergence are measurable.",
    },
    {
        "id": "M9",
        "name": "Decision & Alert Engine",
        "description": "Determines relevance, priority and recipients of warnings.",
        "source": "app/decisions/alerts.py",
        "status": "implemented",
        "notes": "Route-relevance filtering; delivery delayed by a cloud round trip in centralized configurations.",
    },
    {
        "id": "M10",
        "name": "Emergency Coordination",
        "description": "Handles verified emergency events and response workflows.",
        "source": "app/emergency/corridor.py",
        "status": "implemented",
        "notes": "Predictive corridor: signal preemption and yield instructions ahead of the ambulance.",
    },
    {
        "id": "M11",
        "name": "Security & Trust",
        "description": "Authentication, message integrity and pseudonymous identities.",
        "source": "app/network/pseudonyms.py, app/network/security.py, app/network/corroboration.py",
        "status": "implemented",
        "notes": "Rotating pseudonym certificates, freshness + nonce replay defence, and density-aware corroboration trust. Uses HMAC rather than a real 1609.2 PKI.",
    },
    {
        "id": "M12",
        "name": "Visualization Dashboard",
        "description": "Displays live traffic state, RSUs, alerts and analytics for authorities.",
        "source": "frontend/src/pages/ControlCenter.tsx",
        "status": "implemented",
        "notes": "Live digital-twin map over WebSocket, plus federated learning, security and experiment consoles.",
    },
]
