import { acceptInvite } from "@/app/admin/actions";
import { crmSelect } from "@/lib/crm";
import AuthCard, { Field } from "@/components/admin/AuthCard";
import ColorPicker from "@/components/admin/ColorPicker";
import { btnCls, inputCls, Notice } from "@/components/admin/bits";
import { ErrorBox } from "@/components/admin/ui";

export const dynamic = "force-dynamic";

export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  let valid = false;
  try {
    const [inv] = await crmSelect<{ expires_at: string; used_at: string | null }>(
      "crm_invites",
      `select=expires_at,used_at&token=eq.${encodeURIComponent(decodeURIComponent(token))}`,
    );
    valid = !!inv && !inv.used_at && new Date(inv.expires_at).getTime() > Date.now();
  } catch (e) {
    return <ErrorBox error={e} />;
  }
  if (!valid) {
    return (
      <AuthCard title="招待リンクが使えません" lead="使用済みか、期限（7 日）が切れています。メンバーに新しいリンクを発行してもらってください。">
        <span />
      </AuthCard>
    );
  }
  return (
    <AuthCard title="SwipeJob 顧客管理へようこそ" lead="アカウントを作ると、すぐに使い始められます。">
      {error && <Notice kind="error">{error}</Notice>}
      <form action={acceptInvite} className="space-y-4">
        <input type="hidden" name="token" value={decodeURIComponent(token)} />
        <Field label="名前（担当者として表示されます）">
          <input name="name" required className={inputCls} />
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
        <button className={`${btnCls} w-full`}>アカウントを作る</button>
      </form>
    </AuthCard>
  );
}
