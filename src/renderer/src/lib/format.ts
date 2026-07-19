export function providerLabel(provider: string): string {
  if (provider === "notion") return "Notion";
  if (provider === "google_drive") return "Google Drive";
  return provider;
}

export function formatRelativeTime(iso: string): string {
  const ms = new Date(iso).getTime();
  if (isNaN(ms)) return "recently";
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
