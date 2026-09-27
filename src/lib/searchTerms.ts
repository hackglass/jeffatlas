/**
 * Shared query-expansion logic for matching a free-text topic against
 * people (jeffData.ts) and doc passages (docsData.ts).
 */

/** Loose synonyms so "k8s" finds the Cloud / Kubernetes skill, etc. */
export const SYNONYMS: Record<string, string[]> = {
  kubernetes: ["k8s", "openshift", "cluster", "operator", "cloud", "provisioning"],
  openshift: ["kubernetes", "cluster", "ocp"],
  ai: ["ml", "llm", "vllm", "model", "inference", "instructlab", "granite", "data science", "machine learning", "openshift ai", "rhoai"],
  vllm: ["inference", "llm", "ai", "serving"],
  storage: ["ceph", "rook", "csi", "s3"],
  security: ["keycloak", "auth", "identity", "oidc", "sso", "cve", "compliance"],
  auth: ["keycloak", "identity", "oidc", "sso", "security"],
  payments: ["billing", "commerce", "subscription"],
  java: ["quarkus", "jvm"],
  quarkus: ["java", "jvm"],
  ansible: ["automation", "playbook", "awx", "automation platform", "aap"],
  virtualization: ["kubevirt", "vm", "kvm", "libvirt"],
  observability: ["prometheus", "grafana", "monitoring", "metrics", "logging"],
  frontend: ["react", "typescript", "ui", "patternfly", "console"],
  go: ["golang", "backend"],
  linux: ["rhel", "fedora", "kernel", "os", "bootc", "red hat enterprise linux", "selinux"],
  leadership: ["director", "vp", "manager", "cto", "ceo", "chief"],
  docs: ["documentation", "writer", "technical writer"],
  product: ["product manager", "pm", "roadmap"],
  wifi: ["wi-fi", "internet", "network", "connect"],
  desk: ["seating", "seat", "appspace", "reserve", "booking", "floor", "office space"],
  meals: ["food", "lunch", "cater", "catering", "ezcater", "relish"],
  onboarding: ["new hire", "orientation", "first day", "getting started"],
};

export function terms(topic: string): string[] {
  const raw = topic.toLowerCase().replace(/[^a-z0-9+#./ -]/g, " ").split(/\s+/).filter((t) => t.length > 1);
  const stop = new Set(["the", "and", "who", "has", "have", "with", "for", "in", "on", "of", "most", "best", "deepest", "experience", "expert", "experts", "knows", "about", "someone", "people", "person", "engineer", "engineers", "infrastructure", "team", "our", "at", "red", "hat", "boston", "what", "is", "are", "does", "do", "can", "tell", "me", "you", "your",
    // Bare substrings of common product names ("open" -> "OpenShift" everywhere)
    // that add noise instead of signal; the specific product word still matches.
    "open"]);
  const out = new Set<string>();
  for (const t of raw) {
    if (stop.has(t)) continue;
    out.add(t);
    for (const s of SYNONYMS[t] ?? []) out.add(s);
  }
  return [...out];
}

export function contains(hay: string, needle: string): boolean {
  return hay.toLowerCase().includes(needle);
}
