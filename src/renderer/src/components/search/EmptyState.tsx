const EXAMPLE_QUESTIONS = [
  "How do I get reimbursed?",
  "What does a tech lead do?",
  "Where are onboarding docs?",
  "How do we deploy?",
];

interface EmptyStateProps {
  onSelectQuestion: (question: string) => void;
}

export function EmptyState({
  onSelectQuestion,
}: EmptyStateProps): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <p className="text-muted-foreground mb-6">
        Try searching your synced docs.
      </p>
      <div className="grid grid-cols-2 gap-2 max-w-sm">
        {EXAMPLE_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onSelectQuestion(q)}
            className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground hover:bg-accent transition-colors text-left"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
