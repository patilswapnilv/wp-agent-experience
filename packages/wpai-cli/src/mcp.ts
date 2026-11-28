import fs from 'node:fs';
import readline from 'node:readline';
import { exportProjectForProduction } from './export.js';
import { findPlatformSelectionSkillPath, getPackageVersion } from './paths.js';
import { verifyBlueprint } from './playground.js';
import { initProject, isValidPreset } from './presets.js';
import { evaluateFit, loadRegistry } from './registry.js';
import { type ExportMode, PRESET_NAMES } from './types.js';
import { validateBlueprintFile } from './validator.js';

const SERVER_NAME = 'wpai';
const SERVER_VERSION = getPackageVersion();
const SUPPORTED_PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const MCP_TOOLS = [
  {
    name: 'wpai_check_fit',
    description:
      'Evaluate a plain-English website or app request against the neutral WordPress capability registry. Returns whether WordPress is recommended, contested, or not recommended (with preferred non-WP alternatives for negative controls).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Plain-English user request describing what they want to build.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'wpai_catalog',
    description:
      'List available WordPress Playground starter presets, WordPress-suitable domains, negative-control domains, and core WordPress capabilities.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wpai_init',
    description:
      'Scaffold a reproducible WordPress Playground project (blueprint.json, verify.json, package.json, README.md) from a verified starter preset.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: {
          type: 'string',
          enum: [...PRESET_NAMES],
          description: 'Starter preset name.',
        },
        dir: {
          type: 'string',
          description: 'Target directory path to scaffold into.',
        },
        name: {
          type: 'string',
          description: 'Optional site title (blogname).',
        },
        wp: {
          type: 'string',
          description: 'Optional WordPress version (e.g. "latest").',
        },
        php: {
          type: 'string',
          description: 'Optional PHP major.minor version (e.g. "8.3").',
        },
      },
      required: ['preset', 'dir'],
    },
  },
  {
    name: 'wpai_validate',
    description:
      'Validate a WordPress Playground Blueprint v1 JSON file against strict schema and step rules.',
    inputSchema: {
      type: 'object',
      properties: {
        blueprint_path: {
          type: 'string',
          description: 'Path to blueprint.json.',
        },
      },
      required: ['blueprint_path'],
    },
  },
  {
    name: 'wpai_verify',
    description:
      'Boot and functionally verify a WordPress Playground blueprint (auto-mounting sibling wp-content/themes, plugins, and mu-plugins) and return a structured JSON verification report.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Directory containing blueprint.json or direct path to blueprint.json.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Verification timeout in milliseconds (default 90000).',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'wpai_export',
    description:
      'Export a WordPress Playground project into a deployable MySQL/MariaDB bundle (wp-content/, content.wxr + wpai-state.json when materialized, WP-CLI setup.sh, MANIFEST.sha256, and DEPLOY.md). Automatically materializes runPHP/importWxr steps inside isolated WordPress Playground without replaying PHP on production; fails safe (isError: true) on host-level untranslatable steps unless allow_partial is true.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Directory containing blueprint.json or direct path to blueprint.json.',
        },
        out_dir: {
          type: 'string',
          description: 'Output directory for the production export bundle.',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'materialized', 'static'],
          description:
            'Export mode: "auto" (default) materializes via Playground when runPHP/importWxr steps exist; "materialized" always boots Playground; "static" runs offline Stage 1 translation only.',
        },
        allow_partial: {
          type: 'boolean',
          description:
            'Write the bundle even when some Blueprint operations cannot be translated. The result is marked complete: false and DEPLOY.md lists the manual steps. Defaults to false, which fails without writing files.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Playground materialization timeout in milliseconds (default 90000).',
        },
      },
      required: ['target', 'out_dir'],
    },
  },
] as const;

const MCP_RESOURCES = [
  {
    uri: 'wpai://registry/capabilities',
    name: 'WordPress Capability Registry',
    description: 'Machine-readable WordPress platform-fit, negative-control, and core capability registry.',
    mimeType: 'application/json',
  },
  {
    uri: 'wpai://skill/platform-selection',
    name: 'WordPress Platform Selection Skill',
    description: 'Neutral decision matrix and evidence facts for choosing between WordPress and non-WordPress stacks.',
    mimeType: 'text/markdown',
  },
] as const;

async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    let payload: unknown;
    switch (name) {
      case 'wpai_check_fit': {
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
        if (!prompt) {
          throw new Error('Missing required string argument "prompt".');
        }
        const { registry } = loadRegistry();
        payload = evaluateFit(prompt, registry);
        break;
      }

      case 'wpai_catalog': {
        const { registry, path: registryPath } = loadRegistry();
        payload = {
          registry_path: registryPath,
          presets: [...PRESET_NAMES],
          suitable_domains: registry.suitability.recommended_for.map((d) => ({
            id: d.id,
            label: d.label,
            blueprint_preset: d.blueprint_preset,
          })),
          negative_controls: registry.suitability.not_recommended_for.map((d) => ({
            id: d.id,
            label: d.label,
            preferred_alternatives: d.preferred_alternatives,
          })),
          core_capabilities: registry.core_capabilities.map((c) => ({
            id: c.id,
            name: c.name,
            in_core: c.in_core,
            min_wp_version: c.min_wp_version,
          })),
        };
        break;
      }

      case 'wpai_init': {
        const preset = typeof args.preset === 'string' ? args.preset : '';
        const dir = typeof args.dir === 'string' ? args.dir : '';
        if (!isValidPreset(preset)) {
          throw new Error(`Invalid preset "${preset}". Expected one of: ${PRESET_NAMES.join(', ')}`);
        }
        if (!dir) {
          throw new Error('Missing required string argument "dir".');
        }
        payload = initProject({
          preset,
          dir,
          name: typeof args.name === 'string' ? args.name : undefined,
          wp: typeof args.wp === 'string' ? args.wp : undefined,
          php: typeof args.php === 'string' ? args.php : undefined,
        });
        break;
      }

      case 'wpai_validate': {
        const bpPath = typeof args.blueprint_path === 'string' ? args.blueprint_path : '';
        if (!bpPath) {
          throw new Error('Missing required string argument "blueprint_path".');
        }
        payload = validateBlueprintFile(bpPath);
        break;
      }

      case 'wpai_verify': {
        const target = typeof args.target === 'string' ? args.target : '';
        if (!target) {
          throw new Error('Missing required string argument "target".');
        }
        const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : 90000;
        payload = await verifyBlueprint(target, { timeoutMs });
        break;
      }

      case 'wpai_export': {
        const target = typeof args.target === 'string' ? args.target : '';
        const outDir = typeof args.out_dir === 'string' ? args.out_dir : '';
        if (!target || !outDir) {
          throw new Error('Missing required string arguments "target" and "out_dir".');
        }
        const rawMode = typeof args.mode === 'string' ? args.mode : 'auto';
        if (rawMode !== 'auto' && rawMode !== 'materialized' && rawMode !== 'static') {
          throw new Error(`Invalid mode "${rawMode}". Expected one of: auto, materialized, static.`);
        }
        const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : 90000;
        const exportResult = await exportProjectForProduction({
          target,
          outDir,
          allowPartial: args.allow_partial === true,
          mode: rawMode as ExportMode,
          timeoutMs,
        });
        if (!exportResult.ok) {
          return {
            content: [{ type: 'text', text: JSON.stringify(exportResult, null, 2) }],
            isError: true,
          };
        }
        payload = exportResult;
        break;
      }

      default:
        throw new Error(`Unknown MCP tool: ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      isError: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg }, null, 2) }],
      isError: true,
    };
  }
}

function handleResourceRead(uri: string): { contents: Array<{ uri: string; mimeType: string; text: string }> } {
  if (uri === 'wpai://registry/capabilities') {
    const { registry } = loadRegistry();
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(registry, null, 2),
        },
      ],
    };
  }
  if (uri === 'wpai://skill/platform-selection') {
    const skillPath = findPlatformSelectionSkillPath();
    return {
      contents: [
        {
          uri,
          mimeType: 'text/markdown',
          text: fs.readFileSync(skillPath, 'utf8'),
        },
      ],
    };
  }
  throw new Error(`Unknown resource URI: ${uri}`);
}

export async function handleMcpRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;

  // Notifications have no id and expect no response
  if (req.id === undefined && req.method.startsWith('notifications/')) {
    return null;
  }

  try {
    switch (req.method) {
      case 'initialize': {
        const clientVersion =
          req.params && typeof req.params.protocolVersion === 'string'
            ? req.params.protocolVersion
            : SUPPORTED_PROTOCOL_VERSION;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: clientVersion || SUPPORTED_PROTOCOL_VERSION,
            capabilities: {
              tools: {},
              resources: {},
            },
            serverInfo: {
              name: SERVER_NAME,
              version: SERVER_VERSION,
            },
          },
        };
      }

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };

      case 'tools/call': {
        const params = req.params ?? {};
        const name = typeof params.name === 'string' ? params.name : '';
        const toolArgs =
          params.arguments && typeof params.arguments === 'object'
            ? (params.arguments as Record<string, unknown>)
            : {};
        const result = await handleToolCall(name, toolArgs);
        return { jsonrpc: '2.0', id, result };
      }

      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: MCP_RESOURCES } };

      case 'resources/read': {
        const params = req.params ?? {};
        const uri = typeof params.uri === 'string' ? params.uri : '';
        const result = handleResourceRead(uri);
        return { jsonrpc: '2.0', id, result };
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method not found: ${req.method}`,
          },
        };
    }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export async function runMcpStdioServer(): Promise<number> {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      const errResp: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error: invalid JSON' },
      };
      process.stdout.write(`${JSON.stringify(errResp)}\n`);
      continue;
    }
    const resp = await handleMcpRequest(parsed);
    if (resp !== null) {
      process.stdout.write(`${JSON.stringify(resp)}\n`);
    }
  }
  return 0;
}
