/**
 * 手渡しモードで人が Midjourney の画像を置く場所。
 * - LocalInbox: data/inbox/<ID>/（GitHub Actions では adops-state ブランチの inbox/）
 * - DriveInbox: Google ドライブの共有フォルダ。スマホからでも保存できる
 *
 * どちらも「<ID> という名前のフォルダに PROMPT.txt を作る → 人が画像を入れる → 取り込んだら <ID>.imported に改名」。
 */
import { createSign } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { request, requestJson } from '../util/http.ts';

export interface Inbox {
  readonly kind: string;
  /** フォルダと PROMPT.txt を用意し、人に伝える場所（パスまたは URL）を返す */
  prepare(id: string, promptText: string): Promise<string>;
  /** 置かれた画像（最大4枚）。まだ無ければ null。取り込み済みのものも返す（再制作用） */
  fetch(id: string): Promise<Buffer[] | null>;
  markImported(id: string): Promise<void>;
  /** 置かれた画像を使わないことにする（画像審査で全滅したとき）。次の prepare で新しいフォルダを作る */
  discard(id: string): Promise<void>;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export class LocalInbox implements Inbox {
  readonly kind = 'local';
  private root: string;
  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }
  private dirOf(id: string): string | undefined {
    return [join(this.root, id), join(this.root, `${id}.imported`)].find((d) => existsSync(d));
  }
  async prepare(id: string, promptText: string): Promise<string> {
    const dir = this.dirOf(id) ?? join(this.root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'PROMPT.txt'), promptText);
    // GitHub Actions では data/ が adops-state ブランチの直下になるので、そこからの相対パスで伝える
    return `${basename(this.root)}/${id}/`;
  }
  async fetch(id: string): Promise<Buffer[] | null> {
    const dir = this.dirOf(id);
    if (!dir) return null;
    const files = readdirSync(dir).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase())).sort();
    return files.length ? files.slice(0, 4).map((f) => readFileSync(join(dir, f))) : null;
  }
  async markImported(id: string): Promise<void> {
    const dir = join(this.root, id);
    if (!existsSync(dir)) return;
    rmSync(`${dir}.imported`, { recursive: true, force: true });
    renameSync(dir, `${dir}.imported`);
  }
  async discard(id: string): Promise<void> {
    // 消さずに名前を変える。GitHub Actions の保存時に、リモートに残る古いフォルダを取り込み直さないための印にもなる
    const stamp = Date.now();
    for (const d of [join(this.root, id), join(this.root, `${id}.imported`)]) {
      if (existsSync(d)) renameSync(d, join(this.root, `${id}.rejected-${stamp}${d.endsWith('.imported') ? '-i' : ''}`));
    }
  }
}

// ---------------------------------------------------------------------------
// Google ドライブ（サービスアカウント）
// ---------------------------------------------------------------------------

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

const DRIVE = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** サービスアカウントの JWT でアクセストークンを得る（googleapis を入れずに済ませる）。 */
export function signJwt(sa: ServiceAccount, scope: string, now = Math.floor(Date.now() / 1000)): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', typ: 'JWT' });
  const claims = enc({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key, 'base64url');
  return `${head}.${claims}.${sig}`;
}

export class DriveInbox implements Inbox {
  readonly kind = 'drive';
  private sa: ServiceAccount;
  private rootId: string;
  private token: { value: string; exp: number } | null = null;

  constructor(serviceAccountJson: string, rootFolderId: string) {
    if (!serviceAccountJson || !rootFolderId) throw new Error('Google ドライブの inbox には GOOGLE_SERVICE_ACCOUNT_JSON と DRIVE_INBOX_FOLDER_ID が必要です');
    this.sa = JSON.parse(serviceAccountJson) as ServiceAccount;
    this.rootId = rootFolderId;
  }

  private async auth(): Promise<Record<string, string>> {
    if (!this.token || this.token.exp < Date.now() + 60_000) {
      const r = await requestJson<{ access_token: string; expires_in: number }>('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(this.sa, 'https://www.googleapis.com/auth/drive') }),
      });
      this.token = { value: r.access_token, exp: Date.now() + r.expires_in * 1000 };
    }
    return { authorization: `Bearer ${this.token.value}` };
  }

  private async list(q: string): Promise<{ id: string; name: string; mimeType: string }[]> {
    const qs = new URLSearchParams({ q, fields: 'files(id,name,mimeType)', pageSize: '100', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', orderBy: 'name' });
    const r = await requestJson<{ files: { id: string; name: string; mimeType: string }[] }>(`${DRIVE}/files?${qs}`, { headers: await this.auth() });
    return r.files ?? [];
  }

  private async findFolder(id: string): Promise<{ id: string; name: string } | undefined> {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const found = await this.list(`'${this.rootId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false and (name='${esc(id)}' or name='${esc(id)}.imported')`);
    return found[0];
  }

  async prepare(id: string, promptText: string): Promise<string> {
    let folder = await this.findFolder(id);
    if (!folder) {
      folder = await requestJson<{ id: string; name: string }>(`${DRIVE}/files?supportsAllDrives=true`, {
        method: 'POST',
        headers: await this.auth(),
        json: { name: id, mimeType: FOLDER_MIME, parents: [this.rootId] },
        attempts: 1, // 再送で同名フォルダが2つできるのを防ぐ
      });
    }
    // PROMPT.txt が無ければ置く（前回アップロードに失敗していても次回やり直す）
    const hasPrompt = (await this.list(`'${folder.id}' in parents and name='PROMPT.txt' and trashed=false`)).length > 0;
    if (!hasPrompt) {
      // PROMPT.txt（multipart アップロード）
      const boundary = `adops${Date.now()}`;
      const body = [
        `--${boundary}`,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify({ name: 'PROMPT.txt', parents: [folder.id], mimeType: 'text/plain' }),
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        '',
        promptText,
        `--${boundary}--`,
        '',
      ].join('\r\n');
      try {
        await request('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', {
          method: 'POST',
          headers: { ...(await this.auth()), 'content-type': `multipart/related; boundary=${boundary}` },
          body,
          attempts: 1,
        });
      } catch (e) {
        // サービスアカウントはマイドライブに容量を持たないため、共有ドライブでないと失敗する。プロンプトは Slack にも出るので続行
        console.warn(`PROMPT.txt をドライブに置けませんでした（共有ドライブのフォルダを使ってください）: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    return `https://drive.google.com/drive/folders/${folder.id}`;
  }

  async fetch(id: string): Promise<Buffer[] | null> {
    const folder = await this.findFolder(id);
    if (!folder) return null;
    // sharp で読める形式だけ（iPhone の HEIC は読めないので JPEG で保存してもらう）
    const files = (
      await this.list(`'${folder.id}' in parents and trashed=false and (mimeType='image/png' or mimeType='image/jpeg' or mimeType='image/webp')`)
    ).slice(0, 4);
    if (files.length === 0) return null;
    const out: Buffer[] = [];
    for (const f of files) {
      const res = await request(`${DRIVE}/files/${f.id}?alt=media&supportsAllDrives=true`, { headers: await this.auth() });
      out.push(Buffer.from(await res.arrayBuffer()));
    }
    return out;
  }

  async markImported(id: string): Promise<void> {
    const folder = await this.findFolder(id);
    if (!folder || folder.name.endsWith('.imported')) return;
    await this.rename(folder.id, `${id}.imported`);
  }

  async discard(id: string): Promise<void> {
    // ドライブ上では消さずに名前を変えて残す（人が後で見返せるように）
    const folder = await this.findFolder(id);
    if (folder) await this.rename(folder.id, `${id}.rejected-${Date.now()}`);
  }

  private async rename(fileId: string, name: string): Promise<void> {
    await request(`${DRIVE}/files/${fileId}?supportsAllDrives=true`, { method: 'PATCH', headers: await this.auth(), json: { name }, attempts: 2 });
  }
}
