import { useMemo, useState } from "react";
import type { FileChangeItem } from "@/hooks/useAgentSession";
import { parseUnifiedPatch, type SplitDiffRow } from "@/lib/patch";

interface Props {
  changes: FileChangeItem[];
  basePath?: string;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  changes: FileChangeItem[];
}

function normalizePath(value: string): string {
  return value.replace(/\//g, "\\");
}

function buildTree(changes: FileChangeItem[], basePath?: string): TreeNode {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [], changes: [] };
  const base = basePath ? normalizePath(basePath).replace(/\\+$/, "") : "";
  for (const change of changes) {
    let display = normalizePath(change.path);
    if (base && display.startsWith(base + "\\")) display = display.slice(base.length + 1);
    const segments = display.split("\\").filter((s) => s && s !== ".");
    // Skip a leading drive-letter segment so `C:\Users\...` renders without the drive.
    if (segments.length > 0 && /^[A-Za-z]:$/.test(segments[0])) segments.shift();
    if (segments.length === 0) continue;

    let node = root;
    segments.forEach((seg, i) => {
      const isLast = i === segments.length - 1;
      let child = node.children.find((c) => c.name === seg);
      if (!child) {
        child = {
          name: seg,
          path: node.path ? `${node.path}\\${seg}` : seg,
          isDir: !isLast,
          children: [],
          changes: [],
        };
        node.children.push(child);
      }
      if (isLast) child.changes.push(change);
      node = child;
    });
  }
  const sortTree = (n: TreeNode) => {
    n.children.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sortTree);
  };
  sortTree(root);
  return root;
}

function countChanges(node: TreeNode): { added: number; removed: number; total: number } {
  let added = 0;
  let removed = 0;
  let total = 0;
  const visit = (n: TreeNode) => {
    for (const c of n.changes) {
      total++;
      if (c.action === "delete") removed++;
      else if (c.action === "mkdir") added++;
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

const FOLDER_ICON = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </svg>
);

const FILE_ICON = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
  </svg>
);

function ChangeDetail({ change }: { change: FileChangeItem }) {
  const accent =
    change.action === "write"
      ? "var(--accent)"
      : change.action === "delete"
        ? "var(--diff-del-text, #dc2626)"
        : "var(--text-muted)";
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
        <span style={{ color: accent, fontWeight: 500 }}>{change.action}</span>
        <span>{formatRelativeTime(change.timestamp)}</span>
      </div>
      {change.action === "mkdir" ? (
        <div style={{ padding: "6px 12px", fontSize: 12, color: "var(--text-dim)" }}>Directory created</div>
      ) : change.action === "delete" ? (
        <div style={{ padding: "6px 12px", fontSize: 12, color: "var(--diff-del-text, #dc2626)" }}>Deleted</div>
      ) : change.patch ? (
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
        No file changes in this session yet
      </div>
    );
  }

  const toggleDir = (path: string) => setCollapsedDirs((prev) => ({ ...prev, [path]: !prev[path] }));
  const toggleFile = (path: string) => setExpandedFiles((prev) => ({ ...prev, [path]: !prev[path] }));

  const renderNode = (node: TreeNode, depth: number) => {
    if (node.isDir) {
      const collapsed = collapsedDirs[node.path] === true;
      const counts = countChanges(node);
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
              paddingLeft: 10 + depth * 16,
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
            <span style={{ color: "var(--accent)", display: "flex", flexShrink: 0 }}>{FOLDER_ICON}</span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
              {node.name}
            </span>
            <span style={{ display: "flex", gap: 6, flexShrink: 0, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
              {counts.added > 0 && <span style={{ color: "var(--diff-add-text, #16a34a)" }}>+{counts.added}</span>}
              {counts.removed > 0 && <span style={{ color: "var(--diff-del-text, #dc2626)" }}>-{counts.removed}</span>}
              <span style={{ color: "var(--text-dim)" }}>{counts.total}</span>
            </span>
          </button>
          {!collapsed && <div>{node.children.map((child) => renderNode(child, depth + 1))}</div>}
        </div>
      );
    }

    const expanded = expandedFiles[node.path] === true;
    const counts = countChanges(node);
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
            paddingLeft: 10 + depth * 16,
            background: "none",
            border: "none",
            cursor: "pointer",
            textAlign: "left",
            color: "var(--text)",
            fontSize: 13,
          }}
        >
          <span style={{ color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{expanded ? "▾" : "▸"}</span>
          <span style={{ color: "var(--text-dim)", display: "flex", flexShrink: 0 }}>{FILE_ICON}</span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {node.name}
          </span>
          <span style={{ display: "flex", gap: 6, flexShrink: 0, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
            {counts.added > 0 && <span style={{ color: "var(--diff-add-text, #16a34a)" }}>+{counts.added}</span>}
            {counts.removed > 0 && <span style={{ color: "var(--diff-del-text, #dc2626)" }}>-{counts.removed}</span>}
            <span style={{ color: "var(--text-dim)" }}>{counts.total}</span>
          </span>
        </button>
        {expanded && (
          <div style={{ borderLeft: "1px solid var(--border)", marginLeft: 10 + depth * 16 + 14 }}>
            {node.changes.map((change) => (
              <ChangeDetail key={change.id} change={change} />
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ height: "100%", overflowY: "auto", overflowX: "hidden" }}>
      {root.children.map((child) => renderNode(child, 0))}
    </div>
  );
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
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
