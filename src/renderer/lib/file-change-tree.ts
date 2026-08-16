import type { FileChangeItem } from "@/hooks/useAgentSession";

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  changes: FileChangeItem[];
}

function normalizePath(value: string): string {
  return value.replace(/\//g, "\\");
}

/**
 * Build a nested file tree from a flat list of file changes, stripping the
 * session base path and any leading drive letter so `C:\Users\...` renders as
 * a clean relative tree. Directories sort before files, each alphabetical.
 */
export function buildTree(changes: FileChangeItem[], basePath?: string): TreeNode {
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
      // A bare `mkdir` path records the directory itself as the final segment,
      // so it must stay a directory node even though nothing is nested below it.
      const isDir = !isLast || change.action === "mkdir";
      let child = node.children.find((c) => c.name === seg);
      if (!child) {
        child = {
          name: seg,
          path: node.path ? `${node.path}\\${seg}` : seg,
          isDir,
          children: [],
          changes: [],
        };
        node.children.push(child);
      } else if (!child.isDir && isDir) {
        // A node first seen as a file (e.g. an earlier bare `mkdir` path that
        // was misclassified) that later gains children must become a directory;
        // otherwise its children would never render.
        child.isDir = true;
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
