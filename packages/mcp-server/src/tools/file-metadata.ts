/**
 * mba_file_metadata tool implementation.
 *
 * Returns filesystem metadata for a workspace-scoped path. The goal is to let
 * models probe a file before reading it, eliminating read_file range guessing.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

export interface FileMetadataInput {
  readonly filePath: string;
}

export interface FileMetadataOutput {
  readonly exists: boolean;
  readonly totalLines: number | null;
  readonly sizeBytes: number | null;
  readonly isDirectory: boolean | null;
  readonly lastModified: string | null;
  readonly isBinary: boolean | null;
  readonly hint?: string;
  readonly error?: string;
}

function isPathInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export function createFileMetadataHandler(workspaceRoot: string) {
  return function handleFileMetadata(input: FileMetadataInput): FileMetadataOutput {
    const requested = input.filePath;
    if (typeof requested !== "string" || requested.length === 0) {
      return {
        exists: false,
        totalLines: null,
        sizeBytes: null,
        isDirectory: null,
        lastModified: null,
        isBinary: null,
        error: "filePath is required",
      };
    }

    const absolute = isAbsolute(requested) ? resolve(requested) : resolve(workspaceRoot, requested);
    if (!isPathInside(workspaceRoot, absolute)) {
      return {
        exists: false,
        totalLines: null,
        sizeBytes: null,
        isDirectory: null,
        lastModified: null,
        isBinary: null,
        error: "filePath is outside the workspace",
      };
    }

    const stat = statSync(absolute, { throwIfNoEntry: false });
    if (!stat) {
      return {
        exists: false,
        totalLines: null,
        sizeBytes: null,
        isDirectory: null,
        lastModified: null,
        isBinary: null,
        hint: "File does not exist. Do not retry with modified paths.",
      };
    }

    let totalLines: number | null = null;
    let isBinary: boolean | null = null;
    let hint: string | undefined;

    if (stat.isFile()) {
      try {
        const buffer = readFileSync(absolute);
        // A file is considered binary if it contains a null byte.
        if (buffer.includes(0)) {
          isBinary = true;
          totalLines = null;
          hint = `${input.filePath} is a binary file. read_file cannot parse it. Use run_in_terminal with the appropriate CLI (e.g. sqlite3 for .db/.sqlite files), or session_store_sql for the session database.`;
        } else {
          const content = buffer.toString("utf8");
          // Count lines the same way readClamp does: split on newline.
          totalLines = content.split("\n").length;
          isBinary = false;
        }
      } catch {
        totalLines = null;
        isBinary = null;
      }
    }

    return {
      exists: true,
      totalLines,
      sizeBytes: stat.size,
      isDirectory: stat.isDirectory(),
      lastModified: stat.mtime.toISOString(),
      isBinary,
      hint,
    };
  };
}
