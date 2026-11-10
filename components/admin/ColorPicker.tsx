import { STAFF_COLORS } from "@/lib/crmConstants";

/** アイコンの色を選ぶラジオボタン（JS なしで動く） */
export default function ColorPicker({ value }: { value?: string }) {
  const current = value && STAFF_COLORS.includes(value) ? value : STAFF_COLORS[0];
  return (
    <div className="flex flex-wrap gap-2">
      {STAFF_COLORS.map((c) => (
        <label key={c} className="cursor-pointer">
          <input type="radio" name="color" value={c} defaultChecked={c === current} className="peer sr-only" />
          <span
            className="block h-7 w-7 rounded-full ring-offset-2 peer-checked:ring-2 peer-checked:ring-slate-900"
            style={{ background: c }}
          />
        </label>
      ))}
    </div>
  );
}
