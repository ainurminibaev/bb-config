"""Let the catalog Usage screen read VClaude from BB's shared account source."""
from tokenomics_compat import AnchorMismatch

ANCHOR = '  return machineRows.flat();\n}\n\nexport async function loadCodexResetCredits'
MARKER = 'const vclaudeAccount = await bb.sdk.plugins.callRpc'
ADDITION = '''  try {
    const vclaudeAccount = await bb.sdk.plugins.callRpc({
      pluginId: "thread-account-usage",
      method: "vclaude",
      input: { refresh: false },
      outputSchema: z.object({
        usage: z.object({
          fetchedAt: z.string(), limitUnits: z.number().positive(), remainingUnits: z.number().nonnegative(),
          endsAt: z.string().nullable(),
        }).nullable(),
        error: z.string().nullable(),
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (vclaudeAccount.usage) {
      const usage = vclaudeAccount.usage;
      const end = usage.endsAt && Number.isFinite(Date.parse(usage.endsAt))
        ? new Date(usage.endsAt).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) : null;
      machineRows.push([{
        machineId: "vclaude-account", machineName: "VClaude",
        agentId: "vclaude", agentName: "VClaude", providerId: "vclaude", providerName: "VClaude",
        accountEmail: null, accountIdentity: "vclaude", planLabel: null,
        lastUpdatedAt: usage.fetchedAt,
        status: vclaudeAccount.error ? "error" : "ok", error: vclaudeAccount.error,
        windows: [{
          label: end ? `Тариф до ${end}` : "Тариф",
          usedPercent: Math.max(0, Math.min(100, (1 - usage.remainingUnits / usage.limitUnits) * 100)),
          resetsAt: null,
        }],
      }]);
    }
  } catch {
    // The shared account plugin is optional on installations of Usage.
  }
'''


def rewrite(source: bytes, _version: str) -> bytes:
    text = source.decode()
    newline = '\r\n' if '\r\n' in text else '\n'
    normalized = text.replace('\r\n', '\n')
    if normalized.count(MARKER) == 1:
        return source
    if MARKER in normalized or normalized.count(ANCHOR) != 1:
        raise AnchorMismatch('Usage: не найдено однозначное место подключения квот VClaude.')
    return normalized.replace(ANCHOR, ADDITION + ANCHOR).replace('\n', newline).encode()
