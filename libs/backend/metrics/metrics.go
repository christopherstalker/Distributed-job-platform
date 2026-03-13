package metrics

import "github.com/prometheus/client_golang/prometheus"

type Metrics struct {
	EnqueuedTotal            prometheus.Counter
	StartedTotal             prometheus.Counter
	CompletedTotal           prometheus.Counter
	FailedTotal              prometheus.Counter
	RetriedTotal             prometheus.Counter
	DeadLetteredTotal        prometheus.Counter
	ThrottledTotal           prometheus.Counter
	DuplicateSuppressedTotal prometheus.Counter
	LeaseRecoveredTotal      prometheus.Counter
	ActiveJobs               prometheus.Gauge
	WorkerHeartbeats         prometheus.Counter
	ExecutionHistogram       prometheus.Histogram
	QueueLatencyHistogram    prometheus.Histogram
	WorkerHeartbeatAge       *prometheus.GaugeVec
}

func New(registry prometheus.Registerer, service string) *Metrics {
	namespace := "jobsystem"
	subsystem := service
	m := &Metrics{
		EnqueuedTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "jobs_enqueued_total",
			Help:      "Total number of jobs submitted.",
		}),
		CompletedTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "jobs_completed_total",
			Help:      "Total number of jobs completed.",
		}),
		StartedTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "jobs_started_total",
			Help:      "Total number of jobs started.",
		}),
		FailedTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "jobs_failed_total",
			Help:      "Total number of jobs failed permanently.",
		}),
		RetriedTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "jobs_retried_total",
			Help:      "Total number of jobs scheduled for retry.",
		}),
		DeadLetteredTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "jobs_dead_lettered_total",
			Help:      "Total number of jobs moved to the dead letter queue.",
		}),
		ThrottledTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "jobs_throttled_total",
			Help:      "Total number of jobs throttled before execution.",
		}),
		DuplicateSuppressedTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "jobs_duplicate_suppressed_total",
			Help:      "Total number of duplicate submissions suppressed by idempotency.",
		}),
		LeaseRecoveredTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "jobs_lease_recovered_total",
			Help:      "Total number of expired leases recovered by the scheduler.",
		}),
		ActiveJobs: prometheus.NewGauge(prometheus.GaugeOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "jobs_active",
			Help:      "Current number of active jobs.",
		}),
		WorkerHeartbeats: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "worker_heartbeats_total",
			Help:      "Total number of worker heartbeat updates.",
		}),
		ExecutionHistogram: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "job_execution_seconds",
			Help:      "Job execution duration.",
			Buckets:   prometheus.DefBuckets,
		}),
		QueueLatencyHistogram: prometheus.NewHistogram(prometheus.HistogramOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "job_queue_latency_seconds",
			Help:      "Duration between job eligibility and execution start.",
			Buckets:   prometheus.DefBuckets,
		}),
		WorkerHeartbeatAge: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Namespace: namespace,
			Subsystem: subsystem,
			Name:      "worker_heartbeat_age_seconds",
			Help:      "Age of worker heartbeat observations.",
		}, []string{"worker_id"}),
	}
	registry.MustRegister(
		m.EnqueuedTotal,
		m.StartedTotal,
		m.CompletedTotal,
		m.FailedTotal,
		m.RetriedTotal,
		m.DeadLetteredTotal,
		m.ThrottledTotal,
		m.DuplicateSuppressedTotal,
		m.LeaseRecoveredTotal,
		m.ActiveJobs,
		m.WorkerHeartbeats,
		m.ExecutionHistogram,
		m.QueueLatencyHistogram,
		m.WorkerHeartbeatAge,
	)
	return m
}
