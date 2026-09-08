import type { Core } from '@strapi/types';
import {
  buildUploadMcpToolDefinitions,
  registerUploadMcpTools,
} from '../register-upload-mcp-tools';
import { ACTIONS } from '../../constants';

const makeStrapi = (options: { isEnabled?: boolean; withAi?: boolean } = {}) => {
  const { isEnabled = true, withAi = true } = options;
  const registerTool = jest.fn();

  const strapi = (withAi
    ? { ai: { mcp: { isEnabled: jest.fn(() => isEnabled), registerTool } } }
    : {}) as unknown as Core.Strapi;

  return { strapi, registerTool };
};

const READ_TOOLS = ['list_media', 'get_media', 'list_folders'];

const FOLDER_WRITE_TOOLS = ['create_folder', 'rename_folder', 'move_folder', 'delete_folder'];

const WRITE_TOOLS = ['update_media', ...FOLDER_WRITE_TOOLS];

describe('upload MCP tool registration', () => {
  describe('gating', () => {
    test('registers every tool when the MCP server is enabled', () => {
      const { strapi, registerTool } = makeStrapi({ isEnabled: true });

      registerUploadMcpTools({ strapi });

      expect(registerTool).toHaveBeenCalledTimes(8);
      expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
        ...READ_TOOLS,
        ...WRITE_TOOLS,
      ]);
    });

    test('registers nothing when the MCP server is disabled', () => {
      const { strapi, registerTool } = makeStrapi({ isEnabled: false });

      registerUploadMcpTools({ strapi });

      expect(registerTool).not.toHaveBeenCalled();
    });

    test('does not throw when strapi.ai is unavailable', () => {
      const { strapi, registerTool } = makeStrapi({ withAi: false });

      expect(() => registerUploadMcpTools({ strapi })).not.toThrow();
      expect(registerTool).not.toHaveBeenCalled();
    });
  });

  describe('definitions', () => {
    const tools = buildUploadMcpToolDefinitions();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    test('gates every read tool on plugin::upload.read', () => {
      // `plugin::upload.read` is registered without a subject, so the policy carries an action
      // only. The per-model check lives in the handlers, via the permissions manager.
      for (const name of READ_TOOLS) {
        expect(byName[name].auth.policies).toEqual([{ action: ACTIONS.read }]);
      }
    });

    test('gates update_media on plugin::upload.assets.update, not on read', () => {
      // A read-only token must never reach a write tool, so the write action is the gate.
      expect(byName.update_media.auth.policies).toEqual([{ action: ACTIONS.update }]);
    });

    test('does not pin a policy to a subject the action was never registered with', () => {
      for (const tool of tools) {
        for (const policy of tool.auth.policies) {
          expect(policy).not.toHaveProperty('subject');
        }
      }
    });

    test('never gates a read tool on a write action', () => {
      const actions = READ_TOOLS.flatMap((name) =>
        byName[name].auth.policies.map((policy) => policy.action)
      );

      expect(actions).not.toContain(ACTIONS.update);
      expect(actions).not.toContain(ACTIONS.create);
    });

    test('never gates a tool on the create action — uploading is out of scope', () => {
      const actions = tools.flatMap((tool) => tool.auth.policies.map((policy) => policy.action));

      expect(actions).not.toContain(ACTIONS.create);
    });

    test('tags telemetry with the upload source', () => {
      for (const tool of tools) {
        expect(tool.telemetry.source).toBe('upload');
      }
    });

    test('documents that media uses numeric ids, not documentIds', () => {
      // The content-manager tools key on documentId, which files do not have.
      expect(byName.get_media.description).toMatch(/numeric id/i);
      expect(byName.get_media.description).toMatch(/not documents/i);
    });

    test('exposes an input schema for the tools that take arguments, and none for the folder tree', () => {
      expect(byName.list_media.resolveInputSchema).toBeDefined();
      expect(byName.get_media.resolveInputSchema).toBeDefined();
      expect(byName.update_media.resolveInputSchema).toBeDefined();
      expect(byName.list_folders.resolveInputSchema).toBeUndefined();
    });

    test('points update_media at the right tool for a folder change', () => {
      // An agent that wants to move an asset must be steered from the tool description alone.
      expect(byName.update_media.description).toMatch(/move_media/);
      expect(byName.update_media.description).toMatch(/numeric id/i);
    });

    test('gates every folder write on plugin::upload.assets.update', () => {
      // Folder writes inherit the existing asset permission rather than a folder-specific
      // one: MCP-specific folder RBAC is explicitly out of scope.
      for (const name of FOLDER_WRITE_TOOLS) {
        expect(byName[name].auth.policies).toEqual([{ action: ACTIONS.update }]);
      }
    });

    test('gives every folder write a short-verb telemetry name', () => {
      const expected = {
        create_folder: 'create_folder',
        rename_folder: 'rename_folder',
        move_folder: 'move_folder',
        delete_folder: 'delete_folder',
      };

      for (const [name, telemetryName] of Object.entries(expected)) {
        expect(byName[name].telemetry.name).toBe(telemetryName);
      }
    });

    test('registers rename and move as two separate tools', () => {
      // Both call `folder.update` underneath, but an agent picks by intent: rename changes an
      // attribute, move changes a location — the same split as the asset surface.
      expect(byName.rename_folder).toBeDefined();
      expect(byName.move_folder).toBeDefined();
      expect(byName.rename_folder.description).toMatch(/move_folder/);
      expect(byName.move_folder.description).toMatch(/rename_folder/);
    });

    test('states that rename_folder does not change a folder location', () => {
      expect(byName.rename_folder.description).toMatch(/name only/i);
    });

    test('states that move_folder carries the subtree and rejects its own descendants', () => {
      expect(byName.move_folder.description).toMatch(/subfolders and files/i);
      expect(byName.move_folder.description).toMatch(/cannot be moved into itself/i);
    });

    test('names the destructive, irreversible, cascading behaviour in delete_folder', () => {
      // An agent reads the description as its only warning before an irreversible call.
      const { description } = byName.delete_folder;

      expect(description).toMatch(/destructive/i);
      expect(description).toMatch(/irreversible/i);
      expect(description).toMatch(/cascade/i);
      expect(description).toMatch(/permanently/i);
      expect(description).toMatch(/no undo/i);
    });

    test('warns in delete_folder that usage information is unavailable', () => {
      // "Used in" detection is not in the Media Library MVP, so the tool cannot say whether
      // a contained asset is referenced by a live entry — and must say so.
      const { description } = byName.delete_folder;

      expect(description).toMatch(/used in/i);
      expect(description).toMatch(/cannot (tell|be checked)/i);
    });

    test('steers delete_folder to the dry run first, and to delete_media for assets', () => {
      const { description } = byName.delete_folder;

      expect(description).toMatch(/dryRun/);
      expect(description).toMatch(/delete_media/);
      expect(description).toMatch(/FOLDER ids only/);
    });

    test('defaults delete_folder to a preview, so deleting needs an explicit opt-in', () => {
      // `dryRun` is optional and the handler defaults it to true: omitting the flag must be the
      // safe branch, never the destructive one.
      const schema = byName.delete_folder.resolveInputSchema?.(
        {} as Parameters<NonNullable<typeof byName.delete_folder.resolveInputSchema>>[0]
      );

      const parsed = schema?.safeParse({ ids: [1] });
      expect(parsed?.success).toBe(true);
      expect((parsed as { data: Record<string, unknown> })?.data.dryRun).toBeUndefined();
    });

    test('exposes an input schema for every folder write', () => {
      for (const name of FOLDER_WRITE_TOOLS) {
        expect(byName[name].resolveInputSchema).toBeDefined();
      }
    });

    test('publishes every folder write as a plain object schema the registry can expose', () => {
      // A `.refine()` anywhere here would produce a ZodEffects the tool registry cannot turn
      // into an input JSON Schema.
      for (const name of FOLDER_WRITE_TOOLS) {
        const schema = byName[name].resolveInputSchema?.(
          {} as Parameters<NonNullable<typeof byName.create_folder.resolveInputSchema>>[0]
        );

        expect(schema?.shape).toBeDefined();
      }
    });

    test('documents that folders use numeric ids, not documentIds', () => {
      for (const name of FOLDER_WRITE_TOOLS) {
        expect(byName[name].description).toMatch(/numeric id/i);
      }
    });

    test('publishes update_media as a plain object schema the registry can expose', () => {
      // A `.refine()` would make this a ZodEffects, which the tool registry cannot convert to
      // an input JSON Schema — the "at least one field" rule lives in the handler instead.
      const schema = byName.update_media.resolveInputSchema?.(
        {} as Parameters<NonNullable<typeof byName.update_media.resolveInputSchema>>[0]
      );

      expect(schema?.shape).toBeDefined();
      expect(Object.keys(schema?.shape ?? {}).sort()).toEqual([
        'alternativeText',
        'caption',
        'id',
        'name',
      ]);
    });
  });
});
