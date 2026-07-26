import { useCallback, useEffect, useState } from "react";
import { Button, ScrollArea, Separator, Text } from "@glaze/core/components";
import { useTheme } from "@glaze/core/hooks";
import { cn } from "@glaze/core/utils";
import { CheckCircle2, FileText, GraduationCap, Loader2, PowerOff, SkipForward } from "lucide-react";

type QuestionKind = "single" | "yesno" | "chips" | "text";

interface TrainingQuestion {
  id: string;
  prompt: string;
  kind: QuestionKind;
  options: string[];
  theme: string;
}

interface PendingReview {
  docId: number;
  filename: string;
  questions: TrainingQuestion[];
}

type AnswerValue = string | string[];

const invoke = <T,>(channel: string, ...args: unknown[]): Promise<T> =>
  window.glazeAPI.glaze.ipc.invoke<T>(channel, ...args);

/** A single option chip — selected chips use the accent, others read as subtle controls. */
function Chip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-2.5 py-1 rounded-full text-xs font-medium transition-colors border",
        selected
          ? "bg-accent text-accent-contrast border-transparent"
          : "bg-control-subtle text-primary border-panel hover:bg-control",
      )}
    >
      {label}
    </button>
  );
}

/** Render the right control for a question kind and report changes upward. */
function QuestionControl({
  question,
  value,
  onChange,
}: {
  question: TrainingQuestion;
  value: AnswerValue | undefined;
  onChange: (value: AnswerValue) => void;
}) {
  if (question.kind === "text") {
    return (
      <input
        type="text"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Type an answer…"
        className={cn(
          "w-full rounded-lg border border-panel bg-control-subtle px-2.5 py-1.5 text-sm text-primary",
          "outline-none focus:border-accent focus:ring-1 focus:ring-accent",
        )}
      />
    );
  }

  if (question.kind === "yesno") {
    const current = typeof value === "string" ? value : "";
    return (
      <div className="flex gap-1.5">
        {["Yes", "No"].map((opt) => (
          <Chip key={opt} label={opt} selected={current === opt} onClick={() => onChange(opt)} />
        ))}
      </div>
    );
  }

  if (question.kind === "chips") {
    const current = Array.isArray(value) ? value : [];
    const toggle = (opt: string) =>
      onChange(current.includes(opt) ? current.filter((o) => o !== opt) : [...current, opt]);
    return (
      <div className="flex flex-wrap gap-1.5">
        {question.options.map((opt) => (
          <Chip key={opt} label={opt} selected={current.includes(opt)} onClick={() => toggle(opt)} />
        ))}
      </div>
    );
  }

  // single
  const current = typeof value === "string" ? value : "";
  return (
    <div className="flex flex-wrap gap-1.5">
      {question.options.map((opt) => (
        <Chip key={opt} label={opt} selected={current === opt} onClick={() => onChange(opt)} />
      ))}
    </div>
  );
}

export function TrainingView() {
  useTheme();

  const [review, setReview] = useState<PendingReview | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Load the next pending document (or close the popup when none remain).
  const loadNext = useCallback(async () => {
    setLoading(true);
    try {
      const [next, count] = await Promise.all([
        invoke<PendingReview | null>("training:getPending"),
        invoke<number>("training:getPendingCount"),
      ]);
      setRemaining(count);
      if (!next) {
        void invoke("training:close");
        setReview(null);
        return;
      }
      setReview(next);
      setAnswers({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadNext();
  }, [loadNext]);

  // Escape closes the popup (answers for the current doc are simply not saved).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void invoke("training:close");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const setAnswer = (id: string, value: AnswerValue) => setAnswers((prev) => ({ ...prev, [id]: value }));

  const handleSave = async () => {
    if (!review || saving) return;
    setSaving(true);
    try {
      const payload = review.questions
        .map((q) => ({ id: q.id, value: answers[q.id] ?? (q.kind === "chips" ? [] : "") }))
        .filter((a) => (Array.isArray(a.value) ? a.value.length > 0 : a.value !== ""));
      await invoke("training:saveAnswers", review.docId, payload);
      await loadNext();
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = async () => {
    if (!review || saving) return;
    setSaving(true);
    try {
      await invoke("training:skip", review.docId);
      await loadNext();
    } finally {
      setSaving(false);
    }
  };

  const handleTurnOff = async () => {
    await invoke("training:setMode", false);
    void invoke("training:close");
  };

  const answeredCount = review
    ? review.questions.filter((q) => {
        const v = answers[q.id];
        return Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.trim() !== "";
      }).length
    : 0;

  return (
    <div className="h-full w-full p-2.5">
      <div className="h-full w-full flex flex-col overflow-hidden rounded-2xl bg-popover border border-panel shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 bg-accent text-accent-contrast shrink-0">
          <GraduationCap className="size-4 shrink-0" strokeWidth={2.2} />
          <span className="font-semibold text-sm flex-1">Training Mode</span>
          {remaining > 1 ? (
            <span
              className="rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-medium tabular-nums"
              title={`${remaining} documents waiting for review`}
            >
              {remaining} to review
            </span>
          ) : null}
        </div>

        {loading && !review ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-secondary">
            <Loader2 className="size-6 animate-spin" />
            <Text variant="small" color="secondary">
              Preparing questions…
            </Text>
          </div>
        ) : review ? (
          <>
            {/* Which document this is about */}
            <div className="flex items-center gap-1.5 px-4 py-2 shrink-0">
              <FileText className="size-3.5 text-tertiary shrink-0" />
              <Text variant="small" color="tertiary" className="truncate" title={review.filename}>
                {review.filename}
              </Text>
            </div>

            <Separator />

            {/* Questions */}
            <ScrollArea className="flex-1 min-h-0">
              <div className="px-4 py-3 flex flex-col gap-4">
                {review.questions.map((q, i) => (
                  <div key={q.id} className="flex flex-col gap-2">
                    <div className="flex items-start gap-2">
                      <span className="flex items-center justify-center size-5 rounded-full bg-control-subtle border border-panel text-[11px] font-semibold text-secondary tabular-nums shrink-0 mt-0.5">
                        {i + 1}
                      </span>
                      <div className="flex flex-col gap-0.5 flex-1">
                        {q.theme ? (
                          <Text variant="small" color="tertiary" className="uppercase tracking-wide text-[10px] font-semibold">
                            {q.theme}
                          </Text>
                        ) : null}
                        <Text variant="small" className="font-medium leading-snug">
                          {q.prompt}
                        </Text>
                      </div>
                    </div>
                    <div className="pl-7">
                      <QuestionControl
                        question={q}
                        value={answers[q.id]}
                        onChange={(value) => setAnswer(q.id, value)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>

            <Separator />

            {/* Actions */}
            <div className="px-4 py-3 flex flex-col gap-2 shrink-0">
              <div className="flex items-center gap-2">
                <Button variant="accent" onClick={handleSave} disabled={saving} className="flex-1">
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                  Save Answers
                </Button>
                <Button variant="transparent" onClick={handleSkip} disabled={saving} title="Skip this document">
                  <SkipForward className="size-4" />
                  Skip
                </Button>
              </div>
              <div className="flex items-center justify-between gap-2">
                <Text variant="small" color="tertiary" className="tabular-nums">
                  {answeredCount} of {review.questions.length} answered
                </Text>
                <button
                  type="button"
                  onClick={handleTurnOff}
                  className="flex items-center gap-1 text-secondary hover:text-primary transition-colors"
                >
                  <PowerOff className="size-3.5" />
                  <Text variant="small" color="secondary">
                    Turn off Training Mode
                  </Text>
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <Text variant="small" color="secondary">
              All caught up.
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}
