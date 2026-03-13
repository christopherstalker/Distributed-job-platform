package domain

type JobInspection struct {
	Job         Job                `json:"job"`
	Attempts    []JobAttempt       `json:"attempts"`
	Events      []JobEvent         `json:"events"`
	Graph       DependencyGraph    `json:"graph"`
	Idempotency *IdempotencyRecord `json:"idempotency,omitempty"`
	DeadLetter  *DeadLetter        `json:"deadLetter,omitempty"`
}
