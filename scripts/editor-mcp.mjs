import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const profile =
  process.env.LUMA_PROFILE ??
  (process.platform === 'win32'
    ? join(process.env.APPDATA ?? homedir(), 'Luma')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Luma')
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Luma'))
const photoId = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const expectedRevision = { type: 'integer', minimum: 0 }
const schema = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const tools = [
  {
    name: 'luma_get_photo_statistics',
    description:
      'Exact committed SDR sRGB histogram and clipping counts at the expected revision; endpoints do not establish RAW data loss.',
    inputSchema: schema({ photoId, expectedRevision }),
  },
  {
    name: 'luma_list_photos',
    description: 'List imported photos, 60 per page.',
    inputSchema: schema({ offset: { type: 'integer', minimum: 0 } }, []),
  },
  {
    name: 'luma_get_edits',
    description: 'Read confirmed settings and revision.',
    inputSchema: schema({ photoId }),
  },
  {
    name: 'luma_get_edit_history',
    description: 'Read ordered settings snapshots and history cursor.',
    inputSchema: schema({ photoId }),
  },
  {
    name: 'luma_update_edits',
    description:
      'Commit one nondestructive edit using the expected revision. Conflicts require reloading settings.',
    inputSchema: schema({
      photoId,
      expectedRevision,
      patch: schema(
        {
          exposureEv: { type: 'number', minimum: -5, maximum: 5, multipleOf: 0.01 },
          contrast: { type: 'integer', minimum: -100, maximum: 100 },
          highlights: { type: 'integer', minimum: -100, maximum: 100 },
          shadows: { type: 'integer', minimum: -100, maximum: 100 },
          whites: { type: 'integer', minimum: -100, maximum: 100 },
          blacks: { type: 'integer', minimum: -100, maximum: 100 },

          whiteBalance: {
            oneOf: [
              schema({ mode: { const: 'as-shot' } }),
              schema({
                mode: { const: 'custom' },
                kelvin: { type: 'integer', minimum: 2000, maximum: 25000, multipleOf: 50 },
                tint: { type: 'integer', minimum: -100, maximum: 100 },
              }),
            ],
          },
          lens: schema(
            {
              distortion: { type: 'boolean' },
              vignetting: { type: 'boolean' },
              chromaticAberration: { type: 'boolean' },
            },
            [],
          ),
        },
        [],
      ),
    }),
  },
  ...['undo', 'redo'].map((direction) => ({
    name: `luma_${direction}_edit`,
    description: `${direction === 'undo' ? 'Undo' : 'Redo'} one shared edit.`,
    inputSchema: schema({ photoId, expectedRevision }),
  })),
]
const server = new Server(
  { name: 'luma-editor', version: '1.0.0' },
  { capabilities: { tools: {} } },
)
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (!tools.some((tool) => tool.name === request.params.name))
      throw new Error('Unknown editor tool.')
    const connection = JSON.parse(
      await readFile(join(profile, 'editor', 'connection.json'), 'utf8'),
    )
    if (
      connection.version !== 1 ||
      !Number.isInteger(connection.port) ||
      connection.port < 1 ||
      connection.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(connection.token)
    )
      throw new Error('Invalid editor connection file.')
    const response = await fetch(`http://127.0.0.1:${connection.port}/editor`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request.params.arguments, operation: request.params.name }),
      signal: AbortSignal.timeout(120000),
      redirect: 'error',
    })
    const result = await response.json()
    if (!response.ok || result.error) throw new Error(result.error ?? 'Editor request failed.')
    return {
      content: [{ type: 'text', text: JSON.stringify(result.result) }],
      structuredContent: result.result,
    }
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: String(error) }] }
  }
})
await server.connect(new StdioServerTransport())
