# -*- coding: utf-8 -*-
"""ジョブオプの求人書き出しxlsxを、元ファイルの構造を保ったまま編集する土台。

新規ブックを作らず、ダウンロードしたzipの data シートXMLだけを差し替える。
sharedStrings.xml・styles.xml・MASTER/SHOPシートは元のまま持ち越す。

使い方の例は末尾の __main__ を参照。
"""
import copy
import re
import warnings
import zipfile
import xml.etree.ElementTree as ET

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
ET.register_namespace("", NS)
Q = lambda t: f"{{{NS}}}{t}"
_tag = lambda e: e.tag.split("}")[-1]
col_letter = lambda c: re.match(r"[A-Z]+", c.get("r")).group()


def rich_text(node):
    """<si>/<is> の本文だけを取る。見出しには <rPh>（フリガナ）が入っていて、
    素朴に <t> を全部連結すると『操作コードソウサ』のようになり列がズレる。"""
    out = []
    for ch in node:
        if _tag(ch) == "t":
            out.append(ch.text or "")
        elif _tag(ch) == "r":
            out += [s.text or "" for s in ch if _tag(s) == "t"]
    return "".join(out)


class JobopBook:
    def __init__(self, path, data_sheet=None):
        self.zin = zipfile.ZipFile(path)
        self.sst_part = "xl/sharedStrings.xml"
        self.data_part = data_sheet or self._find_data_sheet()
        self.sst = ET.fromstring(self.zin.read(self.sst_part))
        self._reindex()
        self.sheet = ET.fromstring(self.zin.read(self.data_part))
        self.sheetData = self.sheet.find(Q("sheetData"))
        self.rows = list(self.sheetData)
        self.COL = {self.cell_text(c): col_letter(c) for c in self.rows[1]}
        self.NAME = {v: k for k, v in self.COL.items()}
        self.KIND = self._header_kinds()

    # 見出し行の塗りつぶし色が、その列の扱いを表している。
    #   黄(FFFFA7) = 必須入力 / 無色 = 任意入力 / 灰(C0C0C0) = 出力専用
    # 「出力専用」はファイルに何を書いても取り込まれない。公開/非公開・募集開始日・
    # 保存ステータス・応募総数などがこれで、公開は画面側の操作でしか変えられない。
    _KIND_BY_FILL = {"FFFFFFA7": "必須", "FFC0C0C0": "出力専用"}

    def _header_kinds(self):
        try:
            sty = ET.fromstring(self.zin.read("xl/styles.xml"))
            fills = list(sty.find(Q("fills")))
            xfs = list(sty.find(Q("cellXfs")))
        except Exception:
            return {}
        kinds = {}
        for c in self.rows[1]:
            rgb = None
            try:
                pf = fills[int(xfs[int(c.get("s") or 0)].get("fillId"))].find(Q("patternFill"))
                fg = pf.find(Q("fgColor")) if pf is not None else None
                rgb = fg.get("rgb") if fg is not None else None
            except Exception:
                pass
            kinds[self.cell_text(c)] = self._KIND_BY_FILL.get(rgb, "任意")
        return kinds

    def output_only(self, names):
        """渡した見出しのうち、書いても取り込まれないものを返す。"""
        return [n for n in names if self.KIND.get(n) == "出力専用"]

    def _find_data_sheet(self):
        wb = ET.fromstring(self.zin.read("xl/workbook.xml"))
        rels = ET.fromstring(self.zin.read("xl/_rels/workbook.xml.rels"))
        rid = None
        for sh in wb.iter(Q("sheet")):
            if (sh.get("name") or "").lower() == "data":
                rid = sh.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
        for rel in rels:
            if rel.get("Id") == rid:
                return "xl/" + rel.get("Target").lstrip("/")
        raise RuntimeError("data シートが見つからない")

    def _reindex(self):
        self.texts = [rich_text(si) for si in self.sst]
        self.index_of = {}
        for i, t in enumerate(self.texts):
            self.index_of.setdefault(t, i)

    def sid(self, text):
        """共有文字列のindexを返す。無ければ末尾に足す。"""
        if text in self.index_of:
            return self.index_of[text]
        si = ET.SubElement(self.sst, Q("si"))
        t = ET.SubElement(si, Q("t"))
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        t.text = text
        self._reindex()
        return self.index_of[text]

    def cell_text(self, c):
        if c.get("t") == "s":
            v = c.find(Q("v"))
            return self.texts[int(v.text)] if v is not None else ""
        if c.get("t") == "inlineStr":
            is_ = c.find(Q("is"))
            return rich_text(is_) if is_ is not None else ""
        v = c.find(Q("v"))
        return v.text if v is not None else ""

    def get(self, row, name):
        want = self.COL[name]
        for c in row:
            if col_letter(c) == want:
                return self.cell_text(c)
        return ""

    def find_rows(self, name, value):
        return [r for r in self.rows[2:] if self.get(r, name) == value]

    # ── セル操作 ────────────────────────────────────────────
    def put(self, c, text):
        for ch in list(c):
            c.remove(ch)
        c.set("t", "s")
        ET.SubElement(c, Q("v")).text = str(self.sid(text))

    def blank(self, c):
        """セルは残して中身だけ消す。元ファイルの空欄と同じ <c r=".." s=".."/> 形。
        セルごと削除すると1行の要素数が変わって取り込みが壊れる。"""
        for ch in list(c):
            c.remove(ch)
        c.attrib.pop("t", None)

    def to_shared(self, row):
        """行内の inlineStr（セル内直書き）を全部 共有文字列 に直す。

        ここが一番の勘所。書き出しファイルはデータ列を inlineStr で吐いてくるが、
        ジョブオプの取り込みは共有文字列しか読まない。複製した行を inlineStr のまま
        上げると、見た目は埋まっているのに取り込み側では全項目が空と判定され、
        『採用ホームページIDが設定されていません。』のような必須エラーになる。
        """
        for c in list(row):
            if c.get("t") == "inlineStr":
                is_ = c.find(Q("is"))
                self.put(c, rich_text(is_) if is_ is not None else "")
        return row

    def set_values(self, row, values=None, clear=()):
        """values: {見出し名: 文字列} / clear: 空にする見出し名の集合"""
        ignored = self.output_only(values or ())
        if ignored:
            warnings.warn("出力専用の列なので取り込まれません: " + " / ".join(ignored))
        for c in list(row):
            name = self.NAME.get(col_letter(c))
            if name in clear:
                self.blank(c)
            elif values and name in values:
                self.put(c, values[name])

    def append_copy(self, src_row, values=None, clear=()):
        """既存行を複製して末尾に足す。新規登録(01)はこれを使う。"""
        n = max(int(r.get("r")) for r in list(self.sheetData)) + 1
        row = copy.deepcopy(src_row)
        row.set("r", str(n))
        for c in row:
            c.set("r", f"{col_letter(c)}{n}")
        self.set_values(row, values, clear)
        self.to_shared(row)
        self.sheetData.append(row)
        return row

    def keep_only(self, rows):
        """指定した行だけ残す。※通常は使わないこと。
        マニュアルは『書き出しに行を足す』方式で、既存行を削ると弾かれた実績がある。"""
        for r in list(self.sheetData):
            if r not in rows:
                self.sheetData.remove(r)

    def save(self, out):
        total = len(list(self.sheetData))
        last = max(col_letter(c) for r in self.sheetData for c in r) if total else "A"
        dim = self.sheet.find(Q("dimension"))
        if dim is not None:
            dim.set("ref", f"A1:{last}{total}")
        n = len(list(self.sst))
        self.sst.set("count", str(n))
        self.sst.set("uniqueCount", str(n))

        hdr = b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

        def ser(root):
            # 本文中のCRは元と同じ &#xd; に戻す。生CRのままだと再読込で改行が消える。
            return hdr + ET.tostring(root, encoding="utf-8").replace(b"\r", b"&#xd;")

        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in self.zin.infolist():
                if item.filename == self.data_part:
                    zout.writestr(item, ser(self.sheet))
                elif item.filename == self.sst_part:
                    zout.writestr(item, ser(self.sst))
                else:
                    zout.writestr(item, self.zin.read(item.filename))
        return out


if __name__ == "__main__":
    # 例：既存求人を複製して、別店舗ぶんを新規登録(01)で足す
    #
    # b = JobopBook("求人一覧_20260922.xlsx")
    # src = b.find_rows("求人案件ID", "15964057")[0]
    # b.append_copy(
    #     src,
    #     values={
    #         "操作コード": "01",
    #         "店舗ID": "1106547",
    #         "店舗名": "Winスクール　仙台駅前校",
    #         "管理コメント": "CAD/仙台駅前校",
    #     },
    #     clear=["求人案件ID", "保存ステータス", "応募総数", "バージョン",
    #            "最終更新日時", "最終更新者", "移行前求人案件ID", "管理用 求人案件ID"],
    # )
    # b.save("アップロード用.xlsx")
    #
    # 公開/非公開・募集開始日は出力専用なのでファイルでは指定できない。
    # 取り込みは必ず非公開で入るので、公開は求人案件一覧で一括選択→「公開」。
    pass
