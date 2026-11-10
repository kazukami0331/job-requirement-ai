import { createInvite, updateProfile } from "@/app/admin/actions";
import { listStaff, requireStaff } from "@/lib/auth";
import { formatJst } from "@/lib/swipeAdmin";
import { Field } from "@/components/admin/AuthCard";
import ColorPicker from "@/components/admin/ColorPicker";
import CopyField from "@/components/admin/CopyField";
import { Avatar, btnCls, btnSubCls, inputCls, Notice } from "@/components/admin/bits";
import { ErrorBox } from "@/components/admin/ui";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string; saved?: string; error?: string }>;
}) {
  const { invite, saved, error } = await searchParams;
  const me = await requireStaff();
  let staff;
  try {
    staff = await listStaff();
  } catch (e) {
    return <ErrorBox error={e} />;
  }
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">メンバー</h1>

      <section className="rounded-xl border border-slate-200 bg-white">
        <ul className="divide-y divide-slate-100">
          {staff.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-4 py-3">
              <Avatar name={s.name} color={s.color} size={32} />
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {s.name}
                  {s.id === me.id && <span className="ml-2 text-xs text-slate-400">（あなた）</span>}
                </div>
                <div className="text-xs text-slate-500">{s.email}</div>
              </div>
              <div className="text-right text-xs text-slate-400">
                <div>{s.role === "owner" ? "管理者" : "メンバー"}</div>
                <div>{formatJst(s.created_at, false)} 参加</div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">メンバーを招待する</h2>
        <p className="mt-1 text-sm text-slate-500">
          招待リンクを作って、Slack などで送ってください。リンクは 1 回だけ・7 日間使えます。
        </p>
        {invite ? (
          <div className="mt-4 space-y-2">
            <Notice kind="ok">招待リンクを作りました。この画面を閉じると再表示できないので、今コピーしてください。</Notice>
            <CopyField value={`${origin}/admin/invite/${invite}`} />
          </div>
        ) : null}
        <form action={createInvite} className="mt-4">
          <button className={btnSubCls}>{invite ? "もう 1 つ作る" : "招待リンクを作る"}</button>
        </form>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">自分のプロフィール</h2>
        {saved && <div className="mt-3"><Notice kind="ok">保存しました</Notice></div>}
        {error && <div className="mt-3"><Notice kind="error">{error}</Notice></div>}
        <form action={updateProfile} className="mt-4 grid gap-4 sm:max-w-md">
          <Field label="名前">
            <input name="name" defaultValue={me.name} className={inputCls} />
          </Field>
          <Field label="アイコンの色">
            <ColorPicker value={me.color} />
          </Field>
          <Field label="新しいパスワード" hint="変えるときだけ入力（8 文字以上）">
            <input name="password" type="password" minLength={8} autoComplete="new-password" className={inputCls} />
          </Field>
          <button className={`${btnCls} w-fit`}>保存</button>
        </form>
      </section>
    </div>
  );
}
