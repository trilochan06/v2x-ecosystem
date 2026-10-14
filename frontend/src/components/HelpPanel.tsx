import { useEffect, useRef, useState } from "react";
import { SUGGESTIONS, answerFor, ask, explainAlert, questionFor } from "../sim/assistant";
import type { Answer, AssistantContext } from "../sim/assistant";
import type { PovAlert } from "../sim/pov";

interface Turn {
  question: string;
  answer: Answer;
}

/**
 * The help panel.
 *
 * A transcript rather than a single answer box, because the useful follow-up
 * to "what is a CPM" is "then why does a bicycle get no alerts", and losing
 * the first answer to read the second makes the panel worse at the one thing
 * it is for.
 */
export function HelpPanel({
  ctx,
  pendingAlert,
  onAlertHandled,
}: {
  ctx: AssistantContext;
  /** An alert the viewer pressed "Explain this" on. */
  pendingAlert: PovAlert | null;
  onAlertHandled: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement | null>(null);

  const push = (question: string, answer: Answer) => setTurns((t) => [...t, { question, answer }]);

  // An alert arriving from the POV panel opens the conversation on it.
  useEffect(() => {
    if (!pendingAlert) return;
    push(`Explain: ${pendingAlert.title}`, explainAlert(pendingAlert, ctx));
    onAlertHandled();
    // ctx changes every tick; re-running on it would re-answer the same alert
    // forever. The alert itself is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAlert]);

  // Scroll the transcript, not the page. `scrollIntoView` walks up and moves
  // every scrollable ancestor, so on mount it dragged the whole Control
  // Center down and left the map off-screen — which the end-to-end pass
  // caught as the mouse wheel no longer zooming, because the wheel event was
  // landing on nothing at all.
  useEffect(() => {
    if (!turns.length) return;
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [turns.length]);

  const submit = (question: string) => {
    if (!question.trim()) return;
    push(question, ask(question, ctx));
    setDraft("");
  };

  const openTopic = (topicId: string) => {
    const answer = answerFor(topicId, ctx);
    if (answer) push(questionFor(topicId), answer);
  };

  return (
    <div className="panel help">
      <h2>Help</h2>
      <p className="muted small">
        Answers about this simulation, assembled from the run in front of you. It reads live state,
        so the numbers it quotes are the ones on screen. It is not a language model and will say so
        rather than guess.
      </p>

      <div className="help__log" ref={logRef}>
        {turns.length === 0 && (
          <p className="muted small help__empty">
            Ask something, or pick a question below. In a vehicle view, &ldquo;Explain this&rdquo;
            on any alert opens it here.
          </p>
        )}
        {turns.map((turn, i) => (
          <div key={i} className="help__turn">
            <p className="help__q">{turn.question}</p>
            <div className="help__a">
              <h3>{turn.answer.title}</h3>
              {turn.answer.body.map((p, j) =>
                p ? <p key={j}>{p}</p> : <hr key={j} className="help__rule" />,
              )}
              {turn.answer.related.length > 0 && (
                <div className="help__related">
                  {turn.answer.related.map((id) => (
                    <button key={id} type="button" onClick={() => openTopic(id)}>
                      {questionFor(id)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <form
        className="help__ask"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        <input
          id="help-question"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask about anything on screen…"
          aria-label="Ask a question about the simulation"
        />
        <button type="submit">Ask</button>
      </form>

      {turns.length === 0 && (
        <div className="help__suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s.id} type="button" onClick={() => openTopic(s.id)}>
              {s.question}
            </button>
          ))}
        </div>
      )}

      {turns.length > 0 && (
        <button type="button" className="help__clear" onClick={() => setTurns([])}>
          Clear
        </button>
      )}
    </div>
  );
}
