"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, ClipboardCopy, Download, Search } from "lucide-react";

export type InteractiveCell = {
  content: ReactNode;
  text: string;
  className: string;
};

export type InteractiveRow = {
  id: string;
  cells: InteractiveCell[];
  searchText: string;
};

type SortState = {
  index: number;
  direction: "asc" | "desc";
} | null;

export function InteractiveDataTable({ columns, rows }: { columns: { label: string; className: string }[]; rows: InteractiveRow[] }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const nextRows = normalizedQuery ? rows.filter((row) => row.searchText.toLowerCase().includes(normalizedQuery)) : rows.slice();
    if (!sort) return nextRows;
    return nextRows.sort((left, right) => {
      const a = comparable(left.cells[sort.index]?.text || "");
      const b = comparable(right.cells[sort.index]?.text || "");
      const result = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), "zh-CN", { numeric: true });
      return sort.direction === "asc" ? result : -result;
    });
  }, [query, rows, sort]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const visibleRows = filteredRows.slice((safePage - 1) * pageSize, safePage * pageSize);

  function changeSort(index: number) {
    setPage(1);
    setSort((current) => {
      if (!current || current.index !== index) return { index, direction: "asc" };
      if (current.direction === "asc") return { index, direction: "desc" };
      return null;
    });
  }

  function changeQuery(value: string) {
    setQuery(value);
    setPage(1);
  }

  function exportCsv() {
    const csv = toCsv(columns.map((column) => column.label), filteredRows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `quantos-table-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function copyRows() {
    const text = toTsv(columns.map((column) => column.label), filteredRows);
    await navigator.clipboard.writeText(text);
  }

  return (
    <div className="interactiveTable">
      <div className="tableToolbar">
        <label className="tableSearch">
          <Search size={15} />
          <input value={query} onChange={(event) => changeQuery(event.target.value)} placeholder="搜索当前表格" />
        </label>
        <div className="tableToolbarActions">
          <select
            aria-label="每页行数"
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
          >
            {[10, 25, 50].map((size) => <option key={size} value={size}>{size} 行</option>)}
          </select>
          <button className="iconTextButton" type="button" onClick={copyRows} disabled={!filteredRows.length}>
            <ClipboardCopy size={15} />
            复制
          </button>
          <button className="iconTextButton" type="button" onClick={exportCsv} disabled={!filteredRows.length}>
            <Download size={15} />
            CSV
          </button>
        </div>
      </div>
      <div className="productTableWrap">
        <table className="productTable financialTable">
          <thead>
            <tr>
              {columns.map((column, index) => {
                const active = sort?.index === index;
                const SortIcon = active ? (sort.direction === "asc" ? ArrowUp : ArrowDown) : ChevronsUpDown;
                return (
                  <th className={column.className} key={column.label}>
                    <button className={`sortButton ${active ? "active" : ""}`} type="button" onClick={() => changeSort(index)}>
                      <span>{column.label}</span>
                      <SortIcon size={13} />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visibleRows.length ? visibleRows.map((row) => (
              <tr key={row.id}>
                {row.cells.map((cell, cellIndex) => (
                  <td className={cell.className} key={`${row.id}-${cellIndex}`}>{cell.content}</td>
                ))}
              </tr>
            )) : (
              <tr><td className="tableEmpty" colSpan={columns.length}>暂无匹配数据</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="tableFooter">
        <span className="tableMeta">显示 {visibleRows.length} / {filteredRows.length} 行，共 {rows.length} 行</span>
        <div className="tablePager">
          <button className="pagerButton" type="button" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
          <span>{safePage} / {pageCount}</span>
          <button className="pagerButton" type="button" disabled={safePage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>下一页</button>
        </div>
      </div>
    </div>
  );
}

function comparable(value: string) {
  const numeric = Number(value.replace(/[%¥,$,\s]/g, ""));
  if (Number.isFinite(numeric) && value.trim() !== "") return numeric;
  return value;
}

function toCsv(columns: string[], rows: InteractiveRow[]) {
  return [columns, ...rows.map((row) => row.cells.map((cell) => cell.text))].map((line) => line.map(csvCell).join(",")).join("\n");
}

function toTsv(columns: string[], rows: InteractiveRow[]) {
  return [columns, ...rows.map((row) => row.cells.map((cell) => cell.text))].map((line) => line.join("\t")).join("\n");
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}
