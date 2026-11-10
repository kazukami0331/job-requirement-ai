import { redirect } from "next/navigation";
import { setupOwner } from "@/app/admin/actions";
import { crmSelect } from "@/lib/crm";
import AuthCard, { Field } from "@/components/admin/AuthCard";
import ColorPicker from "@/components/admin/ColorPicker";
import { btnCls, inputCls, Notice } from "@/components/admin/bits";
import { ErrorBox } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default async function SetupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  try {
    if ((await crmSelect<{ id: string }>("crm_staff", "select=id&limit=1")).length > 0) redirect("/admin/login");
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e; // redirect はそのまま通す
    return <ErrorBox error={e} />;
  }
  return (
    <AuthCard
      title="管理者アカウントを作る"
      lead="最初の 1 人だけの手順です。合言葉には Vercel の環境変数 ADMIN_PASSWORD に入れた値を入力してください。"
    >
      {error && <Notice kind="error">{error}</Notice>}
      <form action={setupOwner} className="space-y-4">
        <Field label="合言葉（ADMIN_PASSWORD）">
          <input name="bootstrap" type="password" required className={inputCls} />
        </Field>
        <Field label="名前（担当者として表示されます）">
          <input name="name" required className={inputCls} placeholder="紙谷" />
        </Field>
        <Field label="メールアドレス（ログイン ID）">
          <input name="email" type="email" required className={inputCls} />
        </Field>
        <Field label="パスワード" hint="8 文字以上">
          <input name="password" type="password" required minLength={8} autoComplete="new-password" className={inputCls} />
        </Field>
        <Field label="アイコンの色">
          <ColorPicker />
        </Field>
        <button className={`${btnCls} w-full`}>作成してはじめる</button>
      </form>
    </AuthCard>
  );
}
