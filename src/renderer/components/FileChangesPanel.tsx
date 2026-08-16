import { useMemo, useState, type CSSProperties } from "react";
import type { FileChangeItem } from "@/hooks/useAgentSession";
import { parseUnifiedPatch, type SplitDiffRow } from "@/lib/patch";
import { buildTree, type TreeNode } from "@/lib/file-change-tree";
import { useI18n } from "@/i18n";
import { FolderIcon, getFileIcon } from "./FileIcons";

interface Props {
  changes: FileChangeItem[];
  basePath?: string;
}

type NodeState = "normal" | "deleted" | "created";

/**
 * Final visual state of a tree node. A delete strikes the node through; a node
 * that was ever created/mkdir'd (and not deleted since) stays green so a brand
 * new file remains distinguishable even after later edits/modifies. Only a
 * delete clears the created state; re-creating after a delete turns it green
 * again.
 */
function nodeState(node: TreeNode): NodeState {
  const last = node.changes[node.changes.length - 1];
  if (!last) return "normal";
  if (last.action === "delete") return "deleted";
  if (node.changes.some((c) => c.action === "create" || c.action === "mkdir")) return "created";
  return "normal";
}

function nodeNameStyle(state: NodeState): CSSProperties {
  if (state === "deleted") {
    return { color: "var(--diff-del-text, #dc2626)", textDecoration: "line-through" };
  }
  if (state === "created") {
    return { color: "var(--diff-add-text, #16a34a)" };
  }
  return {};
}

function countChanges(node: TreeNode): { added: number; removed: number; total: number } {
  let added = 0;
  let removed = 0;
  let total = 0;
  const visit = (n: TreeNode) => {
    for (const c of n.changes) {
      total++;
      if (c.action === "delete") removed++;
      else if (c.action === "mkdir" || c.action === "create") added++;
      else if (c.action === "modify") added += Math.max(1, countPatchChanges(c.patch).added);
      else {
        added += countPatchChanges(c.patch).added;
        removed += countPatchChanges(c.patch).removed;
      }
    }
    n.children.forEach(visit);
  };
  visit(node);
  return { added, removed, total };
}

function DiffView({ patch }: { patch: string }) {
  const files = useMemo(() => parseUnifiedPatch(patch), [patch]);
  if (!files) {
    return (
      <pre
        style={{
          margin: 0,
          padding: "8px 12px",
          fontSize: 12,
          lineHeight: 1.5,
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "var(--font-mono)",
          color: "var(--text-muted)",
          background: "var(--bg)",
        }}
      >
        {patch}
      </pre>
    );
  }
  return (
    <div style={{ background: "var(--bg)", maxHeight: 420, overflowY: "auto", overflowX: "hidden" }}>
      {files.map((file, fileIndex) => (
        <div key={fileIndex} style={{ fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.55 }}>
          {file.rows.map((row, rowIndex) => (
            <DiffRow key={rowIndex} row={row} />
          ))}
        </div>
      ))}
    </div>
  );
}

function DiffRow({ row }: { row: SplitDiffRow }) {
  if (row.type === "hunk") {
    return (
      <div
        style={{
          padding: "1px 12px",
          background: "color-mix(in srgb, var(--bg-panel) 60%, transparent)",
          color: "var(--text-dim)",
        }}
      >
        {row.text}
      </div>
    );
  }
  const { left, right } = row;
  const colorFor = (type: string) =>
    type === "added"
      ? "var(--diff-add-text, #16a34a)"
      : type === "removed"
        ? "var(--diff-del-text, #dc2626)"
        : "var(--text-muted)";
  const bgFor = (type: string) =>
    type === "added"
      ? "color-mix(in srgb, var(--diff-add-bg, #16a34a) 12%, transparent)"
      : type === "removed"
        ? "color-mix(in srgb, var(--diff-del-bg, #dc2626) 12%, transparent)"
        : "transparent";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
      <div
        style={{
          padding: "0 12px",
          color: colorFor(left.type),
          background: bgFor(left.type),
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          minWidth: 0,
        }}
      >
        {left.text}
      </div>
      <div
        style={{
          padding: "0 12px",
          color: colorFor(right.type),
          background: bgFor(right.type),
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          minWidth: 0,
        }}
      >
        {right.text}
      </div>
    </div>
  );
}

function ChangeDetail({ change, t }: { change: FileChangeItem; t: (key: string, fallback: string) => string }) {
  const accent =
    change.action === "create"
      ? "var(--diff-add-text, #16a34a)"
      : change.action === "delete"
        ? "var(--diff-del-text, #dc2626)"
        : change.action === "modify"
          ? "var(--accent)"
          : "var(--text-muted)";
  const actionLabel =
    change.action === "create"
      ? t("fileChangeCreated", "Created")
      : change.action === "modify"
        ? t("fileChangeModified", "Modified")
        : change.action === "edit"
          ? t("fileChangeEdited", "Edited")
          : change.action === "mkdir"
            ? t("fileChangeDirectoryCreated", "Directory created")
            : t("fileChangeDeleted", "Deleted");
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "4px 12px",
          color: "var(--text-dim)",
          fontSize: 11,
          background: "var(--bg-panel)",
        }}
      >
        <span style={{ color: accent, fontWeight: 500 }}>{actionLabel}</span>
        <span>{formatRelativeTime(change.timestamp, t)}</span>
      </div>
      {change.patch ? (
        <DiffView patch={change.patch} />
      ) : change.content ? (
        <pre
          style={{
            margin: 0,
            padding: "8px 12px",
            fontSize: 12,
            lineHeight: 1.5,
            maxHeight: 260,
            overflowY: "auto",
            overflowX: "hidden",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "var(--font-mono)",
            color: "var(--text-muted)",
            background: "var(--bg)",
          }}
        >
          {change.content.slice(0, 4000)}
          {change.content.length > 4000 ? "\n…" : ""}
        </pre>
      ) : null}
    </div>
  );
}

export function FileChangesPanel({ changes, basePath }: Props) {
  const { t } = useI18n();
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const root = useMemo(() => buildTree(changes, basePath), [changes, basePath]);

  if (root.children.length === 0) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-dim)",
          fontSize: 13,
          padding: 16,
          textAlign: "center",
        }}
      >
        {t("fileChangesEmpty", "No file changes in this session yet")}
      </div>
    );
  }

  const toggleDir = (path: string) => setCollapsedDirs((prev) => ({ ...prev, [path]: !prev[path] }));
  const toggleFile = (path: string) => setExpandedFiles((prev) => ({ ...prev, [path]: !prev[path] }));

  const renderNode = (node: TreeNode) => {
    if (node.isDir) {
      const collapsed = collapsedDirs[node.path] === true;
      const counts = countChanges(node);
      const state = nodeState(node);
      const nameStyle = nodeNameStyle(state);
      return (
        <div key={node.path || "root"}>
          <button
            type="button"
            onClick={() => toggleDir(node.path)}
            aria-expanded={!collapsed}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "7px 10px",
              paddingLeft: 8,
              background: "none",
              border: "none",
              cursor: "pointer",
              textAlign: "left",
              color: "var(--text)",
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            <span style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{collapsed ? "▸" : "▾"}</span>
            <span style={{ display: "flex", flexShrink: 0, color: "var(--text-dim)" }}>
              <FolderIcon size={14} open={!collapsed} />
            </span>
            <span
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
                ...nameStyle,
              }}
            >
              {node.name}
            </span>
            <span style={{ display: "flex", gap: 6, flexShrink: 0, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
              {counts.added > 0 && <span style={{ color: "var(--diff-add-text, #16a34a)" }}>+{counts.added}</span>}
              {counts.removed > 0 && <span style={{ color: "var(--diff-del-text, #dc2626)" }}>-{counts.removed}</span>}
              <span style={{ color: "var(--text-dim)" }}>{counts.total}</span>
            </span>
          </button>
          {!collapsed && (
            <div style={{ borderLeft: "1px solid var(--border)", marginLeft: 8 }}>
              {node.changes.map((change) => (
                <ChangeDetail key={change.id} change={change} t={t} />
              ))}
              {node.children.map((child) => renderNode(child))}
            </div>
          )}
        </div>
      );
    }

    const expanded = expandedFiles[node.path] === true;
    const counts = countChanges(node);
    const state = nodeState(node);
    const nameStyle = nodeNameStyle(state);
    return (
      <div key={node.path}>
        <button
          type="button"
          onClick={() => toggleFile(node.path)}
          aria-expanded={expanded}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "6px 10px",
            paddingLeft: 8,
            background: "none",
            border: "none",
            cursor: "pointer",
            textAlign: "left",
            color: "var(--text)",
            fontSize: 13,
          }}
        >
          <span style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{expanded ? "▾" : "▸"}</span>
          <span style={{ display: "flex", flexShrink: 0, color: "var(--text-dim)" }}>{getFileIcon(node.name, 14)}</span>
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
              ...nameStyle,
            }}
          >
            {node.name}
          </span>
          <span style={{ display: "flex", gap: 6, flexShrink: 0, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
            {counts.added > 0 && <span style={{ color: "var(--diff-add-text, #16a34a)" }}>+{counts.added}</span>}
            {counts.removed > 0 && <span style={{ color: "var(--diff-del-text, #dc2626)" }}>-{counts.removed}</span>}
            <span style={{ color: "var(--text-dim)" }}>{counts.total}</span>
          </span>
        </button>
        {expanded && (
          <div style={{ borderLeft: "1px solid var(--border)", marginLeft: 8 }}>
            {node.changes.map((change) => (
              <ChangeDetail key={change.id} change={change} t={t} />
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", overflowX: "hidden" }}>
      {root.children.map((child) => renderNode(child))}
    </div>
  );
}

function formatRelativeTime(timestamp: number, t: (key: string, fallback: string) => string): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return t("fileChangeTimeSecondsAgo", "{n}s ago").replace("{n}", String(seconds));
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("fileChangeTimeMinutesAgo", "{n}m ago").replace("{n}", String(minutes));
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("fileChangeTimeHoursAgo", "{n}h ago").replace("{n}", String(hours));
  return t("fileChangeTimeDaysAgo", "{n}d ago").replace("{n}", String(Math.round(hours / 24)));
}

function countPatchChanges(patch: string | undefined): { added: number; removed: number } {
  if (!patch) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}
