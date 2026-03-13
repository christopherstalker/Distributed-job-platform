package domain

import "fmt"

type DependencyFailurePolicy string

const (
	DependencyFailurePolicyBlock       DependencyFailurePolicy = "block"
	DependencyFailurePolicyAllowFailed DependencyFailurePolicy = "allow_failed"
)

type JobDependency struct {
	JobID          string `json:"jobId"`
	DependsOnJobID string `json:"dependsOnJobId"`
}

type DependencyNode struct {
	JobID            string                  `json:"jobId"`
	Type             string                  `json:"type"`
	State            JobState                `json:"state"`
	Queue            string                  `json:"queue"`
	ParentJobID      string                  `json:"parentJobId,omitempty"`
	WorkflowID       string                  `json:"workflowId,omitempty"`
	BlockedReason    string                  `json:"blockedReason,omitempty"`
	DependencyPolicy DependencyFailurePolicy `json:"dependencyPolicy"`
	DependsOn        []string                `json:"dependsOn,omitempty"`
	Dependents       []string                `json:"dependents,omitempty"`
}

type DependencyGraph struct {
	RootJobID string           `json:"rootJobId"`
	Nodes     []DependencyNode `json:"nodes"`
}

func (p DependencyFailurePolicy) Normalize() DependencyFailurePolicy {
	switch p {
	case DependencyFailurePolicyAllowFailed:
		return DependencyFailurePolicyAllowFailed
	default:
		return DependencyFailurePolicyBlock
	}
}

func (p DependencyFailurePolicy) Validate() error {
	switch p.Normalize() {
	case DependencyFailurePolicyBlock, DependencyFailurePolicyAllowFailed:
		return nil
	default:
		return fmt.Errorf("invalid dependencyPolicy %q", p)
	}
}
