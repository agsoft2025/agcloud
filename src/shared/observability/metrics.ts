type LabelMap = Map<string, number>;
type HistData = { buckets: number[]; observations: Map<string, number[]> };

const counters = new Map<string, LabelMap>();
const histograms = new Map<string, HistData>();

function labelKey(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return "__default__";
  return Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${v}"`).join(",");
}

export function createCounter(name: string, _help: string) {
  counters.set(name, new Map());
  return {
    inc(labels?: Record<string, string>, value = 1) {
      const key = labelKey(labels);
      const m = counters.get(name)!;
      m.set(key, (m.get(key) ?? 0) + value);
    },
    value(labels?: Record<string, string>) {
      return counters.get(name)?.get(labelKey(labels)) ?? 0;
    },
  };
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function createHistogram(name: string, _help: string, buckets = DEFAULT_BUCKETS) {
  histograms.set(name, { buckets, observations: new Map() });
  return {
    observe(labels: Record<string, string>, value: number) {
      const key = labelKey(labels);
      const h = histograms.get(name)!;
      const arr = h.observations.get(key) ?? [];
      arr.push(value);
      h.observations.set(key, arr);
    },
  };
}

export const httpRequestsTotal = createCounter("http_requests_total", "Total HTTP requests");
export const httpRequestDuration = createHistogram("http_request_duration_seconds", "HTTP request duration");
export const callsInitiated = createCounter("calls_initiated_total", "Total calls initiated");
export const callsAccepted = createCounter("calls_accepted_total", "Total calls accepted");
export const callsRejected = createCounter("calls_rejected_total", "Total calls rejected");
export const callsEnded = createCounter("calls_ended_total", "Total calls ended");
export const callsMissed = createCounter("calls_missed_total", "Total missed calls");
export const pushNotificationsSent = createCounter("push_notifications_sent_total", "Push notifications sent");
export const pushNotificationsFailed = createCounter("push_notifications_failed_total", "Push notification failures");

export function getMetricsContentType(): string {
  return "text/plain; version=0.0.4; charset=utf-8";
}

export async function getMetrics(): Promise<string> {
  const lines: string[] = [];

  for (const [name, labelMap] of counters) {
    lines.push(`# TYPE ${name} counter`);
    for (const [labelStr, value] of labelMap) {
      const suffix = labelStr === "__default__" ? "" : `{${labelStr}}`;
      lines.push(`${name}${suffix} ${value}`);
    }
  }

  for (const [name, { buckets, observations }] of histograms) {
    lines.push(`# TYPE ${name} histogram`);
    for (const [labelStr, values] of observations) {
      const lp = labelStr === "__default__" ? "" : `${labelStr},`;
      const sum = values.reduce((a, b) => a + b, 0);
      for (const le of buckets) {
        lines.push(`${name}_bucket{${lp}le="${le}"} ${values.filter((v) => v <= le).length}`);
      }
      lines.push(`${name}_bucket{${lp}le="+Inf"} ${values.length}`);
      lines.push(`${name}_sum{${labelStr === "__default__" ? "" : labelStr}} ${sum}`);
      lines.push(`${name}_count{${labelStr === "__default__" ? "" : labelStr}} ${values.length}`);
    }
  }

  return lines.join("\n") + "\n";
}
