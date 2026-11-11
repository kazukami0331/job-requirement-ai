"use client";

import { FIELD_LABEL, PLACEMENT_FIELDS, PlacementField } from "@/lib/recruiting/placement";
import { SLOTS, SLOT_LABEL, Slot } from "@/lib/recruiting/slots";
import { HireMatrix, Staffing, StaffingCell, StaffingRow } from "@/lib/recruiting/staffing";
import { HR_CATEGORY_LABEL } from "@/lib/recruiting/hrsheet";
import { SortTh, sorted, useSort } from "./hrsheet";

/**
 * 校舎 × 分野 × 時間帯 の充足。
 *
 * 採用のゴールは委託講師配置表の不足数が0になること。
 * ただしコースだけ合っていても、入れる時間帯が合わなければコマは埋まらないので、
 * 9つのマス（3分野 × 3時間帯）で「不足コマ」と「その枠に入れる合格者」を並べる。
 */

const cell = "px-1.5 py-1 text-xs tabular whitespace-nowrap text-center";
const SHOP_W = "7.5rem";
const SLOT_W = "3.9rem";
const NUM_W = "4.5rem";

/**
 * 1マス。「残り / 不足」ではなく「採用 / 不足」で出す。
 * 不足が0のところは薄い「–」にして、空いている枠だけが目に入るようにする。
 */
function Cell({ c }: { c: StaffingCell }) {
  if (c.shortage === 0 && c.hired === 0) return <span style={{ color: "var(--text-muted)" }}>–</span>;
  if (c.shortage === 0) {
    // 不足が無いのに採用がある。配置表より先に採れている（または配置表が更新済み）。
    return <span style={{ color: "var(--text-secondary)" }}>+{c.hired}</span>;
  }
  const done = c.remaining === 0;
  return (
    <span>
      <span style={{ color: done ? "var(--status-good)" : c.hired ? "var(--text-primary)" : "var(--status-critical)", fontWeight: 600 }}>
        {c.hired}
      </span>
      <span style={{ color: "var(--text-muted)" }}> / {c.shortage}</span>
    </span>
  );
}

type Key = string;

export function StaffingTable({ data }: { data: Staffing }) {
  const sort = useSort<Key>();
  if (data.rows.length === 0) return null;

  const value = (r: StaffingRow, key: Key): number | string => {
    if (key === "shop") return r.shopShortName;
    if (key === "need") return r.needHires;
    if (key === "remaining") return r.total.remaining;
    if (key === "hired") return r.hiredPeople;
    const [f, s] = key.split("|");
    return r.cells[f as PlacementField][s as Slot].remaining;
  };

  const groupBorder = { borderLeft: "1px solid var(--gridline)" };

  const body = (r: StaffingRow) => (
    <>
      {PLACEMENT_FIELDS.flatMap((f) =>
        SLOTS.map((s, i) => (
          <td key={`${f}|${s}`} className={cell} style={i === 0 ? groupBorder : undefined}>
            <Cell c={r.cells[f][s]} />
          </td>
        ))
      )}
      <td className={cell} style={{ ...groupBorder, color: "var(--text-secondary)" }}>
        {r.hiredPeople || "–"}
      </td>
      <td className={cell}>
        <span
          style={{
            color: r.total.remaining === 0 ? "var(--status-good)" : "var(--status-critical)",
            fontWeight: 600,
          }}
        >
          {r.total.remaining}
        </span>
        <span style={{ color: "var(--text-muted)" }}> / {r.total.shortage}</span>
      </td>
      <td className={cell}>
        <span style={{ color: r.needHires === 0 ? "var(--status-good)" : "var(--text-primary)", fontWeight: 600 }}>
          {r.needHires}
        </span>
      </td>
    </>
  );

  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full border-collapse" style={{ tableLayout: "fixed" }}>
        <colgroup>
          <col style={{ width: SHOP_W }} />
          {PLACEMENT_FIELDS.flatMap((f) => SLOTS.map((s) => <col key={`${f}|${s}`} style={{ width: SLOT_W }} />))}
          <col style={{ width: NUM_W }} />
          <col style={{ width: NUM_W }} />
          <col style={{ width: NUM_W }} />
        </colgroup>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--hairline)" }}>
            <SortTh sortKey="shop" state={sort} align="left" rowSpan={2} sticky>
              校舎
            </SortTh>
            {PLACEMENT_FIELDS.map((f) => (
              <th
                key={f}
                colSpan={SLOTS.length}
                scope="colgroup"
                className="px-2 pb-0.5 pt-1.5 text-center text-[11px] font-semibold whitespace-nowrap"
                style={{ ...groupBorder, color: "var(--text-primary)" }}
              >
                {FIELD_LABEL[f]}
              </th>
            ))}
            <th
              colSpan={3}
              scope="colgroup"
              className="px-2 pb-0.5 pt-1.5 text-center text-[11px] font-semibold whitespace-nowrap"
              style={{ ...groupBorder, color: "var(--text-secondary)" }}
            >
              校舎の合計
            </th>
          </tr>
          <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
            {PLACEMENT_FIELDS.flatMap((f) =>
              SLOTS.map((s, i) => (
                <SortTh key={`${f}|${s}`} sortKey={`${f}|${s}`} state={sort} align="center" groupStart={i === 0}>
                  {SLOT_LABEL[s].replace("平日", "")}
                </SortTh>
              ))
            )}
            <SortTh sortKey="hired" state={sort} align="center" groupStart>
              採用
            </SortTh>
            <SortTh sortKey="remaining" state={sort} align="center">
              残りコマ
            </SortTh>
            <SortTh sortKey="need" state={sort} align="center">
              不足数
            </SortTh>
          </tr>
        </thead>
        <tbody>
          <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
            <td
              className="sticky left-0 z-10 px-1.5 py-1 text-xs font-semibold whitespace-nowrap"
              style={{ color: "var(--text-primary)", background: "var(--surface-1)" }}
            >
              合計
            </td>
            {body(data.total)}
          </tr>
          {sorted(data.rows, sort, value).map((r) => (
            <tr key={r.key} style={{ borderBottom: "1px solid var(--hairline)" }}>
              <td
                className="sticky left-0 z-10 px-1.5 py-1 text-xs whitespace-nowrap"
                style={{ color: "var(--text-primary)", background: "var(--surface-1)" }}
                title={[r.manager && `管理 ${r.manager}`, r.shopStatus, r.note].filter(Boolean).join(" ／ ")}
              >
                {r.shopShortName}
                {r.stop && (
                  <span className="ml-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
                    停止
                  </span>
                )}
              </td>
              {body(r)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 時間帯ごとに、いま何人入れるのか。
 * 「土日に入れる人がいない」のような偏りは、校舎ごとの表より先に全体で見たい。
 */
export function SlotSummary({ data }: { data: Staffing }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {SLOTS.map((s) => {
        const c = data.total.bySlot[s];
        return (
          <div
            key={s}
            className="rounded-lg border px-2.5 py-2"
            style={{ borderColor: "var(--gridline)", background: "var(--background)" }}
          >
            <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              {SLOT_LABEL[s]}
            </div>
            <div className="text-sm tabular" style={{ color: "var(--text-primary)" }}>
              <span style={{ fontWeight: 600 }}>{c.hired}</span>
              <span style={{ color: "var(--text-muted)" }}> / {c.shortage} コマ</span>
            </div>
            <div className="text-[11px]" style={{ color: c.remaining === 0 ? "var(--status-good)" : "var(--status-critical)" }}>
              残り {c.remaining}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * コース × 時間帯 の採用数。
 *
 * 「W〜Y列の記入が、どのコースの何曜日に効いているのか」を、
 * 委託講師配置表が無くても見られるようにする表。
 * マスはその枠に入れる人数で、1人が複数の枠に入れるなら両方に数える。
 */
export function HireMatrixTable({ data }: { data: HireMatrix }) {
  if (data.total === 0) return null;

  const num = (n: number) => (
    <span style={{ color: n > 0 ? "var(--text-primary)" : "var(--text-muted)" }}>{n || "–"}</span>
  );

  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full border-collapse" style={{ tableLayout: "fixed" }}>
        <colgroup>
          <col />
          {SLOTS.map((s) => (
            <col key={s} style={{ width: "5.5rem" }} />
          ))}
          <col style={{ width: "5.5rem" }} />
        </colgroup>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--gridline)" }}>
            <th className="px-2 py-1.5 text-left text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
              コース
            </th>
            {SLOTS.map((s) => (
              <th key={s} className="px-2 py-1.5 text-center text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
                {SLOT_LABEL[s]}
              </th>
            ))}
            <th className="px-2 py-1.5 text-center text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
              人数
            </th>
          </tr>
        </thead>
        <tbody>
          {data.categories.map((c) => (
            <tr key={c} style={{ borderBottom: "1px solid var(--hairline)" }}>
              <td className={`${cell} text-left`} style={{ color: "var(--text-primary)" }}>
                {HR_CATEGORY_LABEL[c]}
              </td>
              {SLOTS.map((s) => (
                <td key={s} className={cell}>
                  {num(data.cells[c][s])}
                </td>
              ))}
              <td className={`${cell} font-semibold`} style={{ color: "var(--text-primary)" }}>
                {data.people[c]}
              </td>
            </tr>
          ))}
          <tr style={{ borderTop: "1px solid var(--gridline)" }}>
            <td className={`${cell} text-left font-semibold`} style={{ color: "var(--text-primary)" }}>
              合計
            </td>
            {SLOTS.map((s) => (
              <td key={s} className={`${cell} font-semibold`} style={{ color: "var(--series-1)" }}>
                {data.bySlot[s]}
              </td>
            ))}
            <td className={`${cell} font-semibold`} style={{ color: "var(--text-primary)" }}>
              {data.total}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
