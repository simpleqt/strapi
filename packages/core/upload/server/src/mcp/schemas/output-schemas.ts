import { z } from '@strapi/utils';

/**
 * The exhaustive set of asset fields the MCP surface may expose.
 *
 * This is deliberately an ALLOWLIST rather than a denylist: the file content-type carries
 * `provider_metadata` (provider-specific, may hold credentials or private keys), `provider`,
 * `hash`, and the private `folderPath`. A denylist would leak any field added later, so new
 * fields stay invisible to MCP until they are added here on purpose.
 */
export const mediaAssetOutputSchema = z.object({
  id: z.number().describe('Numeric asset id — the canonical identifier for this asset.'),
  name: z.string(),
  alternativeText: z.string().nullable().optional(),
  caption: z.string().nullable().optional(),
  url: z.string().describe('Public (or signed, for private providers) URL of the asset.'),
  mime: z.string().describe('Mime type, e.g. "image/png".'),
  size: z.number().describe('File size in kilobytes, as stored by Strapi.'),
  width: z.number().nullable().optional().describe('Pixel width, images only.'),
  height: z.number().nullable().optional().describe('Pixel height, images only.'),
  ext: z.string().nullable().optional().describe('File extension including the dot, e.g. ".png".'),
  folder: z
    .object({
      id: z.number(),
      name: z.string(),
    })
    .nullable()
    .optional()
    .describe('Containing folder, or null when the asset sits at the media library root.'),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
});

export const getMediaOutputSchema = z.object({
  data: mediaAssetOutputSchema.nullable(),
});

export const listMediaOutputSchema = z.object({
  results: z.array(mediaAssetOutputSchema),
  pagination: z.object({
    page: z.number(),
    pageSize: z.number(),
    pageCount: z.number(),
    total: z.number(),
  }),
});

/**
 * Folder tree node. `children` is recursive and unbounded in depth, so it is typed lazily.
 */
export type MediaFolderNode = {
  id: number;
  name: string;
  children: MediaFolderNode[];
};

export const mediaFolderNodeSchema: z.ZodType<MediaFolderNode> = z.lazy(() =>
  z.object({
    id: z.number(),
    name: z.string(),
    children: z.array(mediaFolderNodeSchema),
  })
);

export const listFoldersOutputSchema = z.object({
  data: z.array(mediaFolderNodeSchema).describe('Nested folder structure, roots first.'),
});

/**
 * `update_media` output — the updated asset in the same shape the read tools return,
 * so an agent can confirm the write without a follow-up `get_media` call.
 */
export const updateMediaOutputSchema = z.object({
  data: mediaAssetOutputSchema,
});

/**
 * A folder as returned by the write tools.
 *
 * Like the asset schema this is an ALLOWLIST: `path` and `pathId` are internal materialized-path
 * bookkeeping and stay invisible to MCP clients, matching what `list_folders` already exposes.
 */
export const mediaFolderOutputSchema = z.object({
  id: z.number().describe('Numeric folder id — the canonical identifier for this folder.'),
  name: z.string(),
  parent: z
    .object({
      id: z.number(),
      name: z.string().optional(),
    })
    .nullable()
    .optional()
    .describe(
      'Containing folder, or null when the folder sits at the media library root. Absent when this response did not load the relation — absent means unknown, not root.'
    ),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
});

export const createFolderOutputSchema = z.object({
  data: mediaFolderOutputSchema,
});

export const renameFolderOutputSchema = z.object({
  data: mediaFolderOutputSchema,
});

export const moveFolderOutputSchema = z.object({
  data: mediaFolderOutputSchema,
});

/**
 * `delete_folder` output — the same shape for both branches, so an agent reads one contract.
 *
 * `dryRun` echoes which branch ran: on true the counts are what *would* be removed and nothing
 * was touched; on false they are what actually was. Echoing it back means the agent can tell a
 * preview from a completed deletion without tracking what it sent.
 *
 * There is no "skipped ids" field: an id that does not resolve to a folder rejects the whole
 * call, so every id in the request is accounted for by `folders` on any successful response.
 */
export const deleteFolderOutputSchema = z.object({
  dryRun: z
    .boolean()
    .describe(
      'True when this was a preview and NOTHING was deleted. False when the deletion was performed.'
    ),
  folders: z
    .array(mediaFolderOutputSchema)
    .describe('The folders matched by the given ids (the roots of the cascade).'),
  totalFolderNumber: z
    .number()
    .describe(
      'Total folders affected, including the matched folders themselves and every descendant.'
    ),
  totalFileNumber: z.number().describe('Total files affected, across the whole cascade.'),
});

/**
 * `move_media` output — a per-id report rather than a single verdict.
 *
 * A bad id among good ones does not roll back the valid moves (see the handler), so the response
 * has to say which ids moved and which did not: an agent that only learned "the call failed"
 * would either retry moves that already happened or abandon ones that did. `moved` and `failed`
 * together account for every id in the request, on every successful response — including one
 * where `moved` is empty because no id resolved.
 *
 * `moved` carries the full asset in the same shape the read tools return, so the new folder can
 * be confirmed without a follow-up `get_media`.
 */
export const moveMediaFailureSchema = z.object({
  id: z.number().describe('The requested asset id that was not moved.'),
  reason: z
    .string()
    .describe('Why this id was not moved — a missing asset, or one this token may not edit.'),
});

export const moveMediaOutputSchema = z.object({
  destinationFolder: z
    .object({
      id: z.number(),
      name: z.string().optional(),
    })
    .nullable()
    .describe(
      'The destination folder, or null when the assets were moved to the media library root.'
    ),
  moved: z
    .array(mediaAssetOutputSchema)
    .describe('The assets that were moved, in their new location.'),
  failed: z
    .array(moveMediaFailureSchema)
    .describe(
      'The ids that were not moved, each with a reason. The moves reported in `moved` still happened — retry only these.'
    ),
});
