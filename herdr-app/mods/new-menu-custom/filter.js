/** Return only agents reported as installed. */
export function installedAgents(agents) {
  if (!Array.isArray(agents)) return [];
  return agents.filter((a) => Boolean(a && a.installed));
}
