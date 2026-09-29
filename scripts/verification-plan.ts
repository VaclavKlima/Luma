export const scopes = ['ui', 'adjustments', 'preview', 'library', 'mcp'] as const
export type Scope = (typeof scopes)[number]
export type Group = 'node' | 'service' | 'electron' | 'raw-gpu' | 'benchmark'

// Every spec belongs to exactly one execution group. Scope membership is explicit;
// selecting several scopes runs their union, independent of the working tree.
interface Suite {
  file: string
  group: Group
  scopes: Scope[]
}
const definitions: Suite[] = [
  { file: 'hdr', group: 'node', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-assets', group: 'service', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-migration', group: 'service', scopes: ['library', 'adjustments'] },
  { file: 'hdr-math-gpu', group: 'raw-gpu', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-raw', group: 'raw-gpu', scopes: ['preview', 'adjustments'] },
  { file: 'hdr-editor-ui', group: 'raw-gpu', scopes: ['ui', 'preview', 'adjustments', 'mcp'] },
  { file: 'hdr-display', group: 'node', scopes: ['preview'] },
  { file: 'hdr-diagnostic-ui', group: 'electron', scopes: ['ui', 'preview'] },
  ...['white-balance', 'statistics', 'contrast', 'highlights', 'tonal-adjustments', 'edits'].map(
    (file) => ({
      file,
      group: 'node' as const,
      scopes: ['adjustments'] as Scope[],
    }),
  ),
  ...['frame-cache', 'preview-geometry', 'lens-correction'].map((file) => ({
    file,
    group: 'node' as const,
    scopes: ['preview'] as Scope[],
  })),
  { file: 'verification', group: 'node', scopes: ['mcp'] },
  ...[
    'white-balance-migration',
    'contrast-migration',
    'highlights-migration',
    'tonal-migration',
    'edit-history',
  ].map((file) => ({
    file,
    group: 'service' as const,
    scopes: ['adjustments', 'library'] as Scope[],
  })),
  { file: 'adjustment-engine', group: 'service', scopes: ['adjustments', 'preview'] },
  { file: 'full-previews', group: 'service', scopes: ['preview', 'adjustments'] },
  ...['library', 'deletion'].map((file) => ({
    file,
    group: 'service' as const,
    scopes: ['library'] as Scope[],
  })),
  { file: 'white-balance-ui', group: 'raw-gpu', scopes: ['ui', 'adjustments'] },
  { file: 'comparison-ui', group: 'electron', scopes: ['ui', 'preview'] },
  { file: 'white-balance-raw', group: 'raw-gpu', scopes: ['adjustments', 'preview'] },
  { file: 'workspace', group: 'electron', scopes: ['ui'] },
  ...['adjustment-input-decimal', 'adjustment-input-integer', 'adjustment-wiring'].map((file) => ({
    file,
    group: 'electron' as const,
    scopes: ['ui', 'adjustments'] as Scope[],
  })),
  { file: 'adjustment-history-ui', group: 'raw-gpu', scopes: ['adjustments'] },
  { file: 'adjustment-renderer-ui', group: 'electron', scopes: ['adjustments', 'preview'] },
  ...['preview', 'preview-pixels-ui'].map((file) => ({
    file,
    group: 'electron' as const,
    scopes: ['ui', 'preview'] as Scope[],
  })),
  { file: 'full-preview-ui', group: 'electron', scopes: ['preview'] },
  { file: 'lens-ui', group: 'electron', scopes: ['adjustments'] },
  ...['import', 'background-import', 'photo-actions'].map((file) => ({
    file,
    group: 'electron' as const,
    scopes: ['library'] as Scope[],
  })),
  { file: 'editor-mcp', group: 'raw-gpu', scopes: ['mcp', 'adjustments'] },
  ...[
    'adjustment-engine-raw',
    'adjustment-renderer-raw-ui',
    'lens-raw-ui',
    'lens-correction-raw',
    'gpu-preview',
  ].map((file) => ({
    file,
    group: 'raw-gpu' as const,
    scopes: ['adjustments', 'preview'] as Scope[],
  })),
  ...['full-previews-raw', 'full-preview-raw-ui'].map((file) => ({
    file,
    group: 'raw-gpu' as const,
    scopes: ['preview'] as Scope[],
  })),
  ...['library-raw', 'import-raw'].map((file) => ({
    file,
    group: 'raw-gpu' as const,
    scopes: ['library'] as Scope[],
  })),
  ...['preview-benchmark', 'adjustment-benchmark', 'hdr-benchmark'].map((file) => ({
    file,
    group: 'benchmark' as const,
    scopes: [] as Scope[],
  })),
]
export const suites = definitions.map((suite) => ({
  ...suite,
  file: `tests/${suite.file}.spec.ts`,
}))

export interface VerificationPlan {
  label: string
  staticChecks: boolean
  build: boolean
  mcp: boolean
  benchmark: boolean
  grep?: string
  groups: { name: Group; files: string[] }[]
}

export function selectPlan(args: string[]): VerificationPlan {
  const requested = args.filter((arg) => arg !== '--plan')
  const mode = requested[0]
  const benchmark = mode === '--benchmark' || mode === '--adjustment-benchmark'
  const internal = ['--fast', '--full', '--functional', '--mcp', '--editor', '--benchmark']
  let selected: typeof suites
  let mcp = false
  let staticChecks = true
  let grep: string | undefined
  if (mode === '--adjustment-benchmark') {
    if (
      requested.length !== 2 ||
      ![
        'exposure',
        'contrast',
        'highlights',
        'shadows',
        'whites',
        'blacks',
        'temperature',
      ].includes(requested[1])
    )
      throw new Error(
        'Choose one adjustment: exposure, contrast, highlights, shadows, whites, blacks, or temperature.',
      )
    selected = suites.filter((s) => s.file === 'tests/adjustment-benchmark.spec.ts')
    grep = `warmed RAW ${requested[1]} gestures`
    staticChecks = false
  } else if (internal.includes(mode)) {
    if (requested.length !== 1) throw new Error(`${mode} does not accept scopes.`)
    mcp = mode === '--full' || mode === '--mcp'
    staticChecks = mode === '--fast' || mode === '--full'
    selected = suites.filter((s) =>
      mode === '--fast'
        ? s.group === 'node'
        : mode === '--mcp'
          ? false
          : mode === '--editor'
            ? s.file === 'tests/editor-mcp.spec.ts'
            : mode === '--benchmark'
              ? s.group === 'benchmark'
              : s.group !== 'benchmark',
    )
  } else {
    if (!requested.length || requested.some((scope) => !scopes.includes(scope as Scope)))
      throw new Error(`Choose scopes: ${scopes.join(', ')}. Use --plan to preview selection.`)
    selected = suites.filter(
      (s) => s.group === 'node' || s.scopes.some((scope) => requested.includes(scope)),
    )
    mcp = requested.includes('mcp')
  }
  const groups = (['node', 'service', 'electron', 'raw-gpu', 'benchmark'] as Group[])
    .map((name) => ({
      name,
      files: selected
        .filter((s) => s.group === name)
        .map((s) => s.file)
        .sort(),
    }))
    .filter((group) => group.files.length)
  return {
    label: [...new Set(requested)].sort().join('+'),
    staticChecks,
    // Library service tests also exercise the bundled preview worker.
    build: mcp || groups.some((group) => group.name !== 'node'),
    mcp,
    benchmark,
    grep,
    groups,
  }
}
