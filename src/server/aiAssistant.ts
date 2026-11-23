import crypto from 'crypto';
import { GoogleGenAI, Type, type Content, type FunctionDeclaration } from '@google/genai';
import type { AuthUser } from './auth.ts';
import {
  addChannelMembers,
  databaseId,
  deleteChannelRecord,
  deleteUserRecord,
  firestoreClient,
  getAiAssistantDiskStore,
  getAllUsersList,
  getChannelById,
  getChannelMembersDetails,
  getChannelMessages,
  getChannelsForUser,
  getUserById,
  getUserChallenge,
  getUserTrades,
  projectId,
  removeChannelMember,
  saveAiAssistantDiskStore,
  saveChannelMessage,
  saveChannelRecord,
  savePrivateMessageRecord,
  togglePinChannelMessage,
  updateUserRecord,
  type ChannelMessage,
  type ChannelRecord,
} from './db.ts';
import { dispatchAuthorizedChatPush } from './fcm.ts';

const OWNER_ID = 1;
const OWNER_USERNAME = 'Salim';
const OWNER_THREAD_ID = 'owner_salim_1';
const GEMINI_MODEL = 'gemini-4-hydrogen';

const AI_FIRESTORE_PROBE_TTL_MS = 10 * 60 * 1000;
let firestoreAiPermWarningLogged = false;
let aiFirestoreSyncCache: { allowed: boolean; checkedAt: number } | null = null;
let aiFirestoreProbeInFlight: Promise<boolean> | null = null;

export interface AiToolStep {
  toolName: string;
  labelAr: string;
  status: 'ok' | 'pending_confirmation' | 'error';
  summaryAr: string;
}

export interface AiNavigationDirective {
  tab: 'dashboard' | 'channels' | 'private_chat' | 'admin' | 'history' | 'roadmap' | 'settings' | 'ai_assistant';
  channelId?: string | null;
  channelName?: string | null;
  partnerId?: number | null;
  partnerName?: string | null;
  messageId?: string | null;
}

export interface AiAssistantThread {
  id: string;
  ownerId: number;
  ownerUsername: string;
  activeSection: string | null;
  activeChannelId: string | null;
  activeChannelName: string | null;
  activePartnerId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AiAssistantMessage {
  id: string;
  threadId: string;
  ownerId: number;
  ownerUsername: string;
  role: 'user' | 'assistant';
  text: string;
  toolSteps?: AiToolStep[] | null;
  draftId?: string | null;
  pendingActionId?: string | null;
  navigation?: AiNavigationDirective | null;
  timestamp: number;
}

export interface VirtualPersonaDraftItem {
  id: string;
  personaName: string;
  dialect: string;
  styleTag: string;
  text: string;
}

export interface AiAssistantDraft {
  id: string;
  ownerId: number;
  ownerUsername: string;
  channelId: string;
  channelName: string;
  topic: string;
  status: 'pending_approval' | 'publishing' | 'published' | 'cancelled';
  items: VirtualPersonaDraftItem[];
  intervalSeconds?: number;
  nextPublishAt?: number | null;
  publishedCount?: number;
  createdAt: number;
  updatedAt: number;
}

const activeDraftTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function clampIntervalSeconds(val: unknown): number {
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.max(0, Math.min(3600, Math.round(num)));
}

export interface AiAssistantPendingAction {
  id: string;
  ownerId: number;
  ownerUsername: string;
  actionType:
    | 'send_channel_message'
    | 'send_private_message'
    | 'create_channel'
    | 'update_channel'
    | 'delete_channel'
    | 'manage_channel_members'
    | 'manage_user'
    | 'pin_channel_message';
  titleAr: string;
  summaryAr: string;
  payload: Record<string, any>;
  status: 'pending' | 'executed' | 'cancelled';
  resultMessage?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AiAssistantAuditLog {
  id: string;
  ownerId: number;
  ownerUsername: string;
  actionType: string;
  command: string;
  target: string;
  status: 'success' | 'pending' | 'cancelled' | 'error';
  details: string;
  timestamp: number;
}

export function isMainOwnerIdentity(user: AuthUser | null | undefined): boolean {
  if (!user) return false;
  if (Number(user.id) !== OWNER_ID) return false;
  if (user.isRestrictedAdmin) return false;
  if (String(user.role || '').toLowerCase() !== 'owner') return false;
  return String(user.username || '').trim().toLowerCase() === 'salim';
}

export async function verifyMainOwnerLive(authUser: AuthUser | undefined, verifiedByJwt: boolean | undefined): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!authUser || !verifiedByJwt) {
    return {
      ok: false,
      status: 401,
      error: 'مطلوب مصادقة جلسة موقعة للمالك الرئيسي Salim للوصول إلى المساعد الذكي.',
    };
  }
  if (!isMainOwnerIdentity(authUser)) {
    return {
      ok: false,
      status: 403,
      error: 'هذا القسم حصري تماماً لحساب المالك الرئيسي (salim) فقط.',
    };
  }
  const dbUser = await getUserById(OWNER_ID);
  if (
    !dbUser ||
    Number(dbUser.id) !== OWNER_ID ||
    dbUser.isRestrictedAdmin ||
    dbUser.role !== 'owner' ||
    String(dbUser.username || '').trim().toLowerCase() !== 'salim'
  ) {
    return {
      ok: false,
      status: 403,
      error: 'تعذر التحقق من صلاحية حساب المالك الرئيسي في قاعدة البيانات.',
    };
  }
  return { ok: true, status: 200 };
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('مفتاح GEMINI_API_KEY غير مهيأ على الخادم في Settings > Secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function sanitizeNoBannedAiDisclaimer(text: string): string {
  return String(text || '')
    .replace(/مول[ّ]?د\s*بالذكاء\s*الاصطناعي/gi, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeArabicForMatch(s: string): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\u064B-\u065F]/g, '');
}

function logAiFirestoreError(operationType: 'write' | 'delete', path: string, error: unknown): void {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
  };
  console.warn('[Salim AI] Firestore sync notice:', JSON.stringify(errInfo));
}

async function canSyncAiFirestore(): Promise<boolean> {
  if (!firestoreClient || !projectId) return false;
  const now = Date.now();
  if (aiFirestoreSyncCache && now - aiFirestoreSyncCache.checkedAt < AI_FIRESTORE_PROBE_TTL_MS) {
    return aiFirestoreSyncCache.allowed;
  }
  if (aiFirestoreProbeInFlight) {
    return aiFirestoreProbeInFlight;
  }

  aiFirestoreProbeInFlight = (async () => {
    try {
      const dbSegment = databaseId && databaseId.trim() ? databaseId.trim() : '(default)';
      const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(dbSegment)}/documents/ai_assistant_threads/${encodeURIComponent(OWNER_THREAD_ID)}`;
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (res.status === 200 || res.status === 404) {
        aiFirestoreSyncCache = { allowed: true, checkedAt: Date.now() };
        return true;
      }

      if (res.status === 401 || res.status === 403) {
        aiFirestoreSyncCache = { allowed: false, checkedAt: Date.now() };
        if (!firestoreAiPermWarningLogged) {
          firestoreAiPermWarningLogged = true;
          console.warn('[Salim AI] Firestore ai_assistant_* rules not yet deployed on project; persisting securely on server store without gRPC writes.');
        }
        return false;
      }

      // Transient non-200/404/403 status: avoid gRPC write spam and re-probe after 1 minute
      aiFirestoreSyncCache = {
        allowed: false,
        checkedAt: Date.now() - (AI_FIRESTORE_PROBE_TTL_MS - 60 * 1000),
      };
      return false;
    } catch {
      aiFirestoreSyncCache = {
        allowed: false,
        checkedAt: Date.now() - (AI_FIRESTORE_PROBE_TTL_MS - 60 * 1000),
      };
      return false;
    } finally {
      aiFirestoreProbeInFlight = null;
    }
  })();

  return aiFirestoreProbeInFlight;
}

async function tryWriteFirestoreDoc(collection: string, docId: string, data: Record<string, any>): Promise<void> {
  if (!(await canSyncAiFirestore())) return;
  const docPath = `${collection}/${docId}`;
  try {
    await firestoreClient.collection(collection).doc(docId).set(data, { merge: true });
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.includes('permission') || msg.includes('PERMISSION_DENIED') || msg.includes('permission-denied')) {
      aiFirestoreSyncCache = { allowed: false, checkedAt: Date.now() };
      if (!firestoreAiPermWarningLogged) {
        firestoreAiPermWarningLogged = true;
        console.warn('[Salim AI] Firestore ai_assistant_* rules not yet deployed on project; persisting securely on server store.');
      }
    } else {
      logAiFirestoreError('write', docPath, err);
    }
  }
}

async function tryDeleteFirestoreDoc(collection: string, docId: string): Promise<void> {
  if (!(await canSyncAiFirestore())) return;
  const docPath = `${collection}/${docId}`;
  try {
    await firestoreClient.collection(collection).doc(docId).delete();
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (msg.includes('permission') || msg.includes('PERMISSION_DENIED') || msg.includes('permission-denied')) {
      aiFirestoreSyncCache = { allowed: false, checkedAt: Date.now() };
    } else {
      logAiFirestoreError('delete', docPath, err);
    }
  }
}

function ensureThread(): AiAssistantThread {
  const store = getAiAssistantDiskStore();
  let t = store.threads?.[OWNER_THREAD_ID] as AiAssistantThread | undefined;
  if (!t) {
    const now = Date.now();
    t = {
      id: OWNER_THREAD_ID,
      ownerId: OWNER_ID,
      ownerUsername: OWNER_USERNAME,
      activeSection: 'ai_assistant',
      activeChannelId: null,
      activeChannelName: null,
      activePartnerId: null,
      createdAt: now,
      updatedAt: now,
    };
    store.threads![OWNER_THREAD_ID] = t;
    saveAiAssistantDiskStore();
    void tryWriteFirestoreDoc('ai_assistant_threads', t.id, t);
  }
  return t;
}

async function updateThreadContext(patch: Partial<AiAssistantThread>): Promise<AiAssistantThread> {
  const store = getAiAssistantDiskStore();
  const current = ensureThread();
  const next: AiAssistantThread = {
    ...current,
    ...patch,
    id: OWNER_THREAD_ID,
    ownerId: OWNER_ID,
    ownerUsername: OWNER_USERNAME,
    updatedAt: Date.now(),
  };
  store.threads![OWNER_THREAD_ID] = next;
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_threads', next.id, next);
  return next;
}

async function appendChatMessage(msg: Omit<AiAssistantMessage, 'id' | 'threadId' | 'ownerId' | 'ownerUsername'>): Promise<AiAssistantMessage> {
  const store = getAiAssistantDiskStore();
  const full: AiAssistantMessage = {
    id: makeId('aimsg'),
    threadId: OWNER_THREAD_ID,
    ownerId: OWNER_ID,
    ownerUsername: OWNER_USERNAME,
    role: msg.role,
    text: sanitizeNoBannedAiDisclaimer(msg.text),
    toolSteps: msg.toolSteps ?? null,
    draftId: msg.draftId ?? null,
    pendingActionId: msg.pendingActionId ?? null,
    navigation: msg.navigation ?? null,
    timestamp: msg.timestamp || Date.now(),
  };
  store.messages!.push(full);
  if (store.messages!.length > 200) {
    store.messages = store.messages!.slice(-200);
  }
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_messages', full.id, full);
  return full;
}

async function appendAuditLog(entry: Omit<AiAssistantAuditLog, 'id' | 'ownerId' | 'ownerUsername' | 'timestamp'>): Promise<AiAssistantAuditLog> {
  const store = getAiAssistantDiskStore();
  const log: AiAssistantAuditLog = {
    id: makeId('aiaudit'),
    ownerId: OWNER_ID,
    ownerUsername: OWNER_USERNAME,
    actionType: entry.actionType.slice(0, 64),
    command: String(entry.command || '').slice(0, 1000),
    target: String(entry.target || '').slice(0, 300),
    status: entry.status,
    details: sanitizeNoBannedAiDisclaimer(String(entry.details || '')).slice(0, 2000),
    timestamp: Date.now(),
  };
  store.auditLogs!.unshift(log);
  if (store.auditLogs!.length > 200) {
    store.auditLogs = store.auditLogs!.slice(0, 200);
  }
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_audit_logs', log.id, log);
  return log;
}

async function resolveChannelTarget(channelQueryOrId?: string | null, fallbackThread?: AiAssistantThread): Promise<ChannelRecord | null> {
  const channels = await getChannelsForUser(OWNER_ID, 'owner');
  if (channels.length === 0) return null;

  const q = String(channelQueryOrId || '').trim();
  if (!q) {
    if (fallbackThread?.activeChannelId) {
      const fromCtx = channels.find((c) => c.id === fallbackThread.activeChannelId);
      if (fromCtx) return fromCtx;
    }
    return null;
  }

  const exactId = channels.find((c) => c.id === q);
  if (exactId) return exactId;

  const normQ = normalizeArabicForMatch(q);
  // Common Arabic aliases for the public general channel
  const isGeneralAlias =
    normQ.includes('القناه العامه') ||
    normQ.includes('الدردشه العامه') ||
    normQ === 'العامه' ||
    normQ === 'عامه' ||
    normQ === 'general';

  if (isGeneralAlias) {
    const openPub =
      channels.find((c) => c.id === 'general_trading') ||
      channels.find((c) => c.visibility === 'public' || c.isOpenPublic) ||
      channels.find((c) => normalizeArabicForMatch(c.name).includes('عامه'));
    if (openPub) return openPub;
  }

  const exactName = channels.find((c) => normalizeArabicForMatch(c.name) === normQ);
  if (exactName) return exactName;

  const partial = channels.find((c) => normalizeArabicForMatch(c.name).includes(normQ) || normQ.includes(normalizeArabicForMatch(c.name)));
  if (partial) return partial;

  return null;
}

async function resolveUserTarget(userQueryOrId: string | number): Promise<{ id: number; username: string; displayName: string; role: string } | null> {
  const raw = String(userQueryOrId || '').trim();
  if (!raw) return null;
  const users = await getAllUsersList();
  if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    const byId = users.find((u) => Number(u.id) === num);
    if (byId) return byId;
  }
  const clean = raw.replace(/^@/, '');
  const norm = normalizeArabicForMatch(clean);
  const exact = users.find(
    (u) =>
      normalizeArabicForMatch(u.username) === norm ||
      normalizeArabicForMatch(u.displayName) === norm
  );
  if (exact) return exact;

  const partial = users.find(
    (u) =>
      normalizeArabicForMatch(u.username).includes(norm) ||
      normalizeArabicForMatch(u.displayName).includes(norm)
  );
  return partial || null;
}

async function generateDiverseVirtualPersonas(params: {
  topic: string;
  count: number;
  channelName: string;
  recentMessagesSample: string[];
}): Promise<VirtualPersonaDraftItem[]> {
  const safeCount = Math.max(1, Math.min(30, Math.floor(Number(params.count) || 5)));
  const users = await getAllUsersList();
  const realNamesSet = new Set<string>();
  for (const u of users) {
    if (u.username) realNamesSet.add(normalizeArabicForMatch(u.username));
    if (u.displayName) realNamesSet.add(normalizeArabicForMatch(u.displayName));
  }

  const ai = getGeminiClient();
  const sampleBlock =
    params.recentMessagesSample.length > 0
      ? `\nأمثلة من آخر رسائل القناة للانسجام مع السياق (لا تنسخها):\n- ${params.recentMessagesSample.slice(-8).join('\n- ')}`
      : '';

  const forbiddenNames = Array.from(realNamesSet).slice(0, 60).join('، ');

  const prompt = `
أنت محرك توليد تفاعلات واقعية ومتنوعة لشخصيات يمنية في مجتمع تداول يديره القائد «سليم» (Salim).
المطلوب: إعداد بالضبط ${safeCount} شخصيات يمنية افتراضية مختلفة، ولكل شخصية رسالة واحدة فريدة موجهة للقناة «${params.channelName}» حول الموضوع التالي:
"${params.topic}"
${sampleBlock}

شروط صارمة للتنوع والأصالة اليمنية (لا تخالف أياً منها):
1. الأسماء اليمنية: اختر ${safeCount} أسماء يمنية واقعية ومتنوعة (ثنائية أو كُنى/ألقاب يمنية مألوفة ذكوراً وإناثاً مثل: أبو حمير، قاسم الحميري، بلقيس اليافعي، عبده القدسي، وضاح الأغبري، أروى الصنعاني، ماهر العولقي، سمية الحضرمي، غمدان المقطري، نشوان السقاف، سوسن العدني، مختار الذماري، نبيل الإرياني، أمل الكميم، صقر الشبواني، طه الشرجبي، رضوان التهامي، هدى البيضاني). يُمنع تماماً استخدام أي اسم متكرر، ويُمنع استخدام الأسماء الحقيقية التالية الموجودة في التطبيق: ${forbiddenNames || 'لا يوجد'}.
2. تنوع اللهجات والأساليب اليمنية: اجعل جميع الشخصيات تتحدث بروح يمنية أصيلة ووزّع الرسائل بين اللهجات والأساليب اليمنية المتنوعة:
   - صنعاني (مثل: ما شاء الله تبارك الله، الله يفتح عليك، سلمت يمناك، حيّا الله القائد، ربنا يبارك في رزقك)
   - عدني (مثل: يا سلام عليك، والله شغل فنان، ربنا يوفقنا جميعاً، تسلم يا غالي، تمام التمام)
   - تعزي / إبّي (مثل: ما شاء الله تبارك الرحمن، كفو يا سليم، الله يزيدك من فضله، خطوة قوية ومرتبة)
   - حضرمي / شبواني / يافعي (مثل: بارك الله فيك، الله يرزقنا وإياكم الخير، تحليل طيب ومبارك، ما قصرت يا أبو سليم)
   - فصحى طبيعية بروح يمنية ودعاء صادق
   يُمنع استخدام لهجات غير يمنية (لا تستخدم مصري أو شامي أو عراقي).
3. تفاوت الطول والتركيب: اجعل بعض الرسائل قصيرة جداً (3-6 كلمات) وبعضها متوسطة (7-14 كلمة) وبعضها بجملتين قصيرتين (15-24 كلمة). نوّع في علامات الترقيم والإيموجي (بعضها بدون إيموجي، بعضها بإيموجي خفيف واحد أو اثنين، ولا تكرر نفس الشكل في الكل).
4. منع النسخ والتكرار: ممنوع تكرار نفس العبارة الافتتاحية أو الخاتمة عبر أكثر من رسالة (مثلاً لا تبدأ كل الرسائل بـ "شكراً سليم"). اجعل كل رسالة تبدو من شخص يمني مختلف فعلاً.
5. يُمنع تماماً كتابة أي عبارة تشير إلى الذكاء الاصطناعي أو التوليد الآلي مثل "مولّد بالذكاء الاصطناعي" أو أي وسوم نظامية.
6. التزم بتفاصيل الموضوع "${params.topic}" بصدق دون اختلاق أرقام لم ترد فيه.
`;

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            personaName: { type: Type.STRING, description: 'الاسم الظاهر للشخصية الافتراضية اليمنية' },
            dialect: { type: Type.STRING, description: 'اللهجة اليمنية أو الأسلوب مثل: صنعاني، عدني، تعزي، حضرمي، إبّي، يافعي، فصحى يمنية' },
            styleTag: { type: Type.STRING, description: 'وصف قصير لطول ونبرة الرسالة' },
            text: { type: Type.STRING, description: 'نص رسالة التفاعل باللهجة أو الروح اليمنية' },
          },
          required: ['personaName', 'dialect', 'styleTag', 'text'],
        },
      },
    },
  });

  const rawText = (response.text || '[]').trim();
  let parsed: any[] = [];
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('تعذر تحليل مخرجات الشخصيات الافتراضية من النموذج.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('لم يُرجع النموذج أي تفاعلات افتراضية.');
  }

  const usedNames = new Set<string>();
  const usedTexts = new Set<string>();
  const fallbackSuffixes = [
    'الحميري',
    'اليافعي',
    'الأغبري',
    'المقطري',
    'السقاف',
    'العولقي',
    'الإرياني',
    'الشرجبي',
    'الذماري',
    'الصنعاني',
    'العدني',
    'الحضرمي',
  ];

  const items: VirtualPersonaDraftItem[] = [];
  for (let i = 0; i < parsed.length && items.length < safeCount; i++) {
    const row = parsed[i] || {};
    let name = sanitizeNoBannedAiDisclaimer(String(row.personaName || `متابع يمني ${i + 1}`)).slice(0, 48).trim();
    if (!name) name = `متداول يمني ${i + 1}`;

    let normName = normalizeArabicForMatch(name);
    if (realNamesSet.has(normName) || usedNames.has(normName)) {
      const suf = fallbackSuffixes[i % fallbackSuffixes.length];
      name = `${name} ${suf}`.slice(0, 48);
      normName = normalizeArabicForMatch(name);
      if (realNamesSet.has(normName) || usedNames.has(normName)) {
        name = `${name} ${i + 11}`;
        normName = normalizeArabicForMatch(name);
      }
    }
    usedNames.add(normName);

    const text = sanitizeNoBannedAiDisclaimer(String(row.text || '')).slice(0, 500).trim();
    const normText = normalizeArabicForMatch(text);
    if (!text || usedTexts.has(normText)) continue;
    usedTexts.add(normText);

    items.push({
      id: `vp_${i + 1}_${crypto.randomBytes(3).toString('hex')}`,
      personaName: name,
      dialect: String(row.dialect || 'يمني').slice(0, 40),
      styleTag: String(row.styleTag || 'متنوع').slice(0, 60),
      text,
    });
  }

  if (items.length === 0) {
    throw new Error('لم يتم توليد رسائل صالحة ومختلفة.');
  }

  return items;
}

const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'list_channels',
    description: 'استعراض جميع القنوات المتاحة في تطبيق Salim مع معرفاتها وحالتها وعدد أعضائها.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'navigate_app',
    description: 'الانتقال إلى قسم معين في التطبيق أو فتح قناة محددة أو محادثة خاصة وتحديث السياق النشط للمساعد.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        section: {
          type: Type.STRING,
          description: 'القسم المستهدف: dashboard | channels | private_chat | admin | history | roadmap | settings | ai_assistant',
        },
        channelQuery: {
          type: Type.STRING,
          description: 'اسم القناة أو معرفها عند التوجه لقناة محددة (مثل: القناة العامة).',
        },
        partnerQuery: {
          type: Type.STRING,
          description: 'اسم المستخدم أو معرفه عند التوجه لمحادثة خاصة.',
        },
      },
      required: ['section'],
    },
  },
  {
    name: 'read_channel_messages',
    description: 'قراءة آخر الرسائل داخل قناة محددة (أو القناة النشطة في السياق الحالي).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        channelQuery: {
          type: Type.STRING,
          description: 'اسم القناة أو معرفها. يُترك فارغاً لاستخدام القناة النشطة حالياً.',
        },
        limit: {
          type: Type.NUMBER,
          description: 'عدد الرسائل المطلوب قراءتها (بين 1 و 50).',
        },
      },
    },
  },
  {
    name: 'list_users',
    description: 'عرض قائمة المستخدمين المسجلين في التطبيق مع أدوارهم ومعرفاتهم.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        search: {
          type: Type.STRING,
          description: 'نص اختياري للبحث باسم المستخدم أو الاسم الظاهر.',
        },
      },
    },
  },
  {
    name: 'read_user_challenge_and_trades',
    description: 'الاطلاع على بيانات تحدي الـ 150 محطة وآخر الصفقات لمستخدم معين.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        userQuery: {
          type: Type.STRING,
          description: 'اسم المستخدم أو معرفه (افتراضياً 1 للمالك).',
        },
      },
    },
  },
  {
    name: 'prepare_virtual_persona_interactions',
    description:
      'إعداد مسودة تفاعلات متعددة بشخصيات يمنية افتراضية متنوعة ومتباينة اللهجة اليمنية والطول لعرضها على المالك للمراجعة والاعتماد قبل النشر، مع إمكانية تحديد فاصل زمني بالثواني بين كل رسالة.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        channelQuery: {
          type: Type.STRING,
          description: 'القناة المستهدفة (اسمها أو معرفها، أو القناة العامة/النشطة إن تُركت فارغة).',
        },
        count: {
          type: Type.NUMBER,
          description: 'عدد التفاعلات والشخصيات المطلوب إعدادها (بين 1 و 30).',
        },
        topic: {
          type: Type.STRING,
          description: 'موضوع التفاعلات أو الصفقة أو الإنجاز المطلوب التفاعل حوله.',
        },
        intervalSeconds: {
          type: Type.NUMBER,
          description: 'الفاصل الزمني بالثواني بين كل رسالة شخصية وأخرى عند النشر (مثلاً 30 أو 60، أو 0 للإرسال الفوري دفعة واحدة).',
        },
      },
      required: ['count', 'topic'],
    },
  },
  {
    name: 'confirm_pending',
    description:
      'تنفيذ أو إلغاء مسودة التفاعلات المعلقة أو الإجراء الإداري المعلق بعد موافقة المالك الصريحة في رسالته الحالية.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        decision: {
          type: Type.STRING,
          description: 'approve لتنفيذ ونشر المعلق، أو cancel لإلغائه.',
        },
        targetId: {
          type: Type.STRING,
          description: 'معرف المسودة أو الإجراء المعلق (اختياري، يختار الأحدث إذا تُرك فارغاً).',
        },
        intervalSeconds: {
          type: Type.NUMBER,
          description: 'فاصل زمني بالثواني بين كل رسالة شخصية وأخرى إذا حدّده المالك عند الموافقة (مثلاً 30 ثانية).',
        },
      },
      required: ['decision'],
    },
  },
  {
    name: 'propose_channel_message',
    description: 'تجهيز إرسال رسالة رسمية باسم القائد Salim في قناة محددة بانتظار تأكيد المالك.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        channelQuery: { type: Type.STRING, description: 'اسم القناة أو معرفها.' },
        text: { type: Type.STRING, description: 'نص الرسالة المطلوب إرسالها.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'propose_private_message',
    description: 'تجهيز إرسال رسالة خاصة من حساب المالك Salim إلى مستخدم محدد بانتظار التأكيد.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        userQuery: { type: Type.STRING, description: 'اسم المستخدم أو معرفه.' },
        text: { type: Type.STRING, description: 'نص الرسالة الخاصة.' },
      },
      required: ['userQuery', 'text'],
    },
  },
  {
    name: 'propose_create_channel',
    description: 'تجهيز إنشاء قناة جديدة في التطبيق بانتظار تأكيد المالك.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: 'اسم القناة.' },
        description: { type: Type.STRING, description: 'وصف القناة.' },
        isOpenPublic: { type: Type.BOOLEAN, description: 'هل القناة مفتوحة للجميع؟' },
        visibility: { type: Type.STRING, description: 'visible أو hidden' },
        password: { type: Type.STRING, description: 'كلمة مرور القناة إن كانت مغلقة.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'propose_update_channel',
    description: 'تجهيز تعديل إعدادات قناة قائمة (الاسم، الوصف، كلمة المرور، الخصوصية) بانتظار التأكيد.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        channelQuery: { type: Type.STRING, description: 'اسم أو معرف القناة الحالية.' },
        name: { type: Type.STRING, description: 'الاسم الجديد (اختياري).' },
        description: { type: Type.STRING, description: 'الوصف الجديد (اختياري).' },
        isOpenPublic: { type: Type.BOOLEAN, description: 'تغيير الفتح للعامة (اختياري).' },
        visibility: { type: Type.STRING, description: 'visible أو hidden (اختياري).' },
        password: { type: Type.STRING, description: 'كلمة المرور الجديدة (اختياري).' },
      },
      required: ['channelQuery'],
    },
  },
  {
    name: 'propose_delete_channel',
    description: 'تجهيز حذف قناة بالكامل (إجراء حساس يتطلب تأكيد المالك الصريح).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        channelQuery: { type: Type.STRING, description: 'اسم القناة أو معرفها المطلوب حذفها.' },
      },
      required: ['channelQuery'],
    },
  },
  {
    name: 'propose_manage_channel_members',
    description: 'تجهيز إضافة عضو إلى قناة أو إزالته منها بانتظار تأكيد المالك.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        operation: { type: Type.STRING, description: 'add أو remove' },
        channelQuery: { type: Type.STRING, description: 'اسم القناة أو معرفها.' },
        userQuery: { type: Type.STRING, description: 'اسم المستخدم أو معرفه.' },
      },
      required: ['operation', 'channelQuery', 'userQuery'],
    },
  },
  {
    name: 'propose_manage_user',
    description: 'تجهيز ترقية/تخفيض رتبة مستخدم (user/moderator) أو حذف حسابه بانتظار تأكيد المالك.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        operation: { type: Type.STRING, description: 'set_role أو delete_user' },
        userQuery: { type: Type.STRING, description: 'اسم المستخدم أو معرفه.' },
        role: { type: Type.STRING, description: 'عند set_role: moderator أو user' },
      },
      required: ['operation', 'userQuery'],
    },
  },
  {
    name: 'propose_pin_channel_message',
    description: 'تجهيز تثبيت أو إلغاء تثبيت رسالة داخل قناة بانتظار تأكيد المالك.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        channelQuery: { type: Type.STRING, description: 'اسم أو معرف القناة.' },
        messageId: { type: Type.STRING, description: 'معرف الرسالة.' },
      },
      required: ['messageId'],
    },
  },
  {
    name: 'get_audit_logs',
    description: 'جلب آخر سجلات التدقيق لعمليات المساعد الذكي.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: { type: Type.NUMBER, description: 'عدد السجلات المطلوبة (حتى 30).' },
      },
    },
  },
];

function buildSystemInstruction(thread: AiAssistantThread, openDraft: AiAssistantDraft | null, openAction: AiAssistantPendingAction | null): string {
  const ctxSummary = [
    `القسم النشط: ${thread.activeSection || 'ai_assistant'}`,
    `القناة النشطة حالياً: ${thread.activeChannelName ? `${thread.activeChannelName} (${thread.activeChannelId})` : 'غير محددة'}`,
    `الشريك النشط بالخاص: ${thread.activePartnerId || 'غير محدد'}`,
    openDraft
      ? `توجد مسودة تفاعلات معلقة بانتظار الاعتماد: id=${openDraft.id} في قناة "${openDraft.channelName}" (${openDraft.items.length} تفاعلات حول "${openDraft.topic}"، الفاصل المبدئي: ${openDraft.intervalSeconds || 0} ثانية).`
      : 'لا توجد مسودة تفاعلات معلقة حالياً.',
    openAction
      ? `يوجد إجراء حساس معلق بانتظار التأكيد: id=${openAction.id} (${openAction.titleAr} — ${openAction.summaryAr}).`
      : 'لا يوجد إجراء إداري معلق حالياً.',
  ].join('\n');

  return `أنت «المساعد الذكي» الشخصي والإداري الحصري لحساب المالك الرئيسي "سليم" (Salim) داخل تطبيق Salim لتحديات التداول وإدارة القنوات.

قواعد السلوك والتنفيذ:
1. خاطب المالك سليم مباشرة بالعربية الطبيعية الواضحة والمهذبة والعملية، وافهم اللهجات والطلبات غير الرسمية.
2. نفّذ المهام فعلياً باستخدام الأدوات المتاحة بدلاً من مجرد شرح الطريقة للمستخدم. بعد تنفيذ أي أداة، اشرح بوضوح ودقة النتيجة الفعلية التي تمت.
3. التزم بالسياق النشط: إذا انتقل المالك لقناة أو قسم في رسالة سابقة ثم قال في رسالة لاحقة "أنشئ تفاعلات" أو "اقرأ الرسائل"، استخدم القناة النشطة في السياق.
4. الشخصيات الافتراضية والتفاعلات (حماية المراجعة والشفافية):
   - عند طلب إنشاء تفاعلات أو رسائل متعددة من شخصيات افتراضية، استدعِ الأداة prepare_virtual_persona_interactions لإعداد مسودة بشخصيات يمنية متنوعة وعرضها على المالك سليم للمراجعة والاعتماد أولاً.
   - إذا حدد المالك وقتاً أو فاصلاً زمنياً بين كل رسالة وأخرى (مثل: "كل 30 ثانية" أو "كل دقيقة")، مرّر قيمة intervalSeconds بالثواني إلى prepare_virtual_persona_interactions أو confirm_pending.
   - لا تنشر التفاعلات تلقائياً قبل مراجعة المالك وموافقته.
   - في هذا التطبيق تُميَّز الشخصيات الافتراضية بشفافية على أنها «شخصية افتراضية»، ولا تُقدَّم تفاعلاتها كشهادات حقيقية لأعضاء مستقلين.
   - يُمنع منعاً باتاً كتابة عبارة "مولّد بالذكاء الاصطناعي" أو ترديدها.
5. الإجراءات الإدارية والحساسة (إرسال رسالة قناة/خاصة، إنشاء/تعديل/حذف قناة، إضافة/إزالة عضو، تغيير دور أو حذف مستخدم، تثبيت رسالة):
   - استخدم أداة propose_* المناسبة لتجهيز الإجراء وعرض ملخصه الواضح للمالك بانتظار تأكيده الصريح.
   - عندما يرد المالك في رسالة لاحقة بالموافقة الصريحة (مثل: "انشرها"، "اعتمد"، "نعم نفذ"، "موافق") أو الإلغاء، استدعِ confirm_pending.
6. كن أميناً ودقيقاً: لا تخترع رسائل أو أسماء أو أرقام غير موجودة في نتائج الأدوات، وإذا تعذر تنفيذ شيء اذكر السبب الفعلي مباشرة.

السياق الحالي:
${ctxSummary}`;
}

export async function getAiAssistantState(): Promise<{
  thread: AiAssistantThread;
  messages: AiAssistantMessage[];
  drafts: AiAssistantDraft[];
  pendingActions: AiAssistantPendingAction[];
  auditLogs: AiAssistantAuditLog[];
}> {
  const store = getAiAssistantDiskStore();
  const thread = ensureThread();
  const messages = [...(store.messages || [])].sort((a, b) => a.timestamp - b.timestamp).slice(-80);
  const drafts = Object.values(store.drafts || {})
    .sort((a: any, b: any) => b.createdAt - a.createdAt)
    .slice(0, 15) as AiAssistantDraft[];
  const pendingActions = Object.values(store.pendingActions || {})
    .sort((a: any, b: any) => b.createdAt - a.createdAt)
    .slice(0, 20) as AiAssistantPendingAction[];
  const auditLogs = [...(store.auditLogs || [])]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 50) as AiAssistantAuditLog[];

  return { thread, messages, drafts, pendingActions, auditLogs };
}

function buildVirtualPersonaChannelMessage(
  draft: AiAssistantDraft,
  channelId: string,
  item: VirtualPersonaDraftItem,
  index: number,
  timestamp: number
): ChannelMessage {
  const hashNum = crypto.createHash('md5').update(`${draft.id}:${item.id}:${index}`).digest().readUInt16BE(0);
  const senderId = -(10001 + (hashNum % 8999));
  return {
    id: `msg_${timestamp}_${index}_${crypto.randomBytes(3).toString('hex')}`,
    channelId,
    senderId,
    senderName: item.personaName,
    senderRole: 'virtual_persona',
    senderAvatarUrl: null,
    text: sanitizeNoBannedAiDisclaimer(item.text),
    reactions: {},
    isPinned: false,
    isDeleted: false,
    isVirtualPersona: true,
    virtualPersonaLabel: 'شخصية افتراضية',
    createdByOwnerId: OWNER_ID,
    timestamp,
  };
}

function clearDraftTimer(draftId: string): void {
  const existing = activeDraftTimers.get(draftId);
  if (existing) {
    clearTimeout(existing);
    activeDraftTimers.delete(draftId);
  }
}

async function publishNextScheduledDraftItem(draftId: string): Promise<void> {
  activeDraftTimers.delete(draftId);
  const store = getAiAssistantDiskStore();
  const draft = store.drafts?.[draftId] as AiAssistantDraft | undefined;
  if (!draft || draft.status !== 'publishing') return;

  const idx = Math.max(0, Number(draft.publishedCount || 0));
  if (idx >= draft.items.length) {
    const completed: AiAssistantDraft = {
      ...draft,
      status: 'published',
      nextPublishAt: null,
      updatedAt: Date.now(),
    };
    store.drafts![draft.id] = completed;
    saveAiAssistantDiskStore();
    await tryWriteFirestoreDoc('ai_assistant_drafts', completed.id, completed);
    return;
  }

  const channel = await getChannelById(draft.channelId);
  if (!channel) {
    const failed: AiAssistantDraft = {
      ...draft,
      status: 'cancelled',
      nextPublishAt: null,
      updatedAt: Date.now(),
    };
    store.drafts![draft.id] = failed;
    saveAiAssistantDiskStore();
    await tryWriteFirestoreDoc('ai_assistant_drafts', failed.id, failed);
    await appendAuditLog({
      actionType: 'publish_virtual_personas',
      command: 'نشر مجدول لشخصيات افتراضية',
      target: `${draft.channelName} (${draft.channelId})`,
      status: 'error',
      details: 'تم إيقاف النشر المجدول لأن القناة المستهدفة لم تعد موجودة.',
    });
    return;
  }

  const now = Date.now();
  const item = draft.items[idx];
  const msg = buildVirtualPersonaChannelMessage(draft, channel.id, item, idx, now);
  await saveChannelMessage(msg);

  dispatchAuthorizedChatPush({
    senderId: msg.senderId,
    senderName: msg.senderName,
    senderRole: 'user',
    title: `💬 ${channel.name}`,
    chatType: 'channel',
    channelId: channel.id,
    messageId: msg.id,
    snippet: msg.text || 'تفاعل جديد في القناة',
  }).catch(() => {});

  const nextPublishedCount = idx + 1;
  const intervalSec = clampIntervalSeconds(draft.intervalSeconds);
  const isDone = nextPublishedCount >= draft.items.length;

  const updated: AiAssistantDraft = {
    ...draft,
    status: isDone ? 'published' : 'publishing',
    publishedCount: nextPublishedCount,
    nextPublishAt: isDone ? null : Date.now() + Math.max(1, intervalSec) * 1000,
    updatedAt: Date.now(),
  };
  store.drafts![draft.id] = updated;
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_drafts', updated.id, updated);

  if (isDone) {
    await appendAuditLog({
      actionType: 'publish_virtual_personas',
      command: 'إتمام النشر المجدول',
      target: `${channel.name} (${channel.id})`,
      status: 'success',
      details: `تم إتمام نشر جميع التفاعلات المجدولة (${nextPublishedCount}/${draft.items.length}) بفاصل ${intervalSec} ثانية حول: ${draft.topic}`,
    });
  } else {
    scheduleDraftTimer(draft.id);
  }
}

function scheduleDraftTimer(draftId: string): void {
  clearDraftTimer(draftId);
  const store = getAiAssistantDiskStore();
  const draft = store.drafts?.[draftId] as AiAssistantDraft | undefined;
  if (!draft || draft.status !== 'publishing') return;

  const nextAt = Number(draft.nextPublishAt || Date.now() + clampIntervalSeconds(draft.intervalSeconds) * 1000);
  const delayMs = Math.max(50, nextAt - Date.now());
  const timer = setTimeout(() => {
    void publishNextScheduledDraftItem(draftId).catch((err) => {
      console.warn('[Salim AI] Scheduled draft tick error:', err?.message || err);
    });
  }, delayMs);
  activeDraftTimers.set(draftId, timer);
}

// Resume any in-progress scheduled drafts cleanly after server restart
setTimeout(() => {
  try {
    const store = getAiAssistantDiskStore();
    for (const draft of Object.values(store.drafts || {}) as AiAssistantDraft[]) {
      if (draft?.id && draft.status === 'publishing') {
        scheduleDraftTimer(draft.id);
      }
    }
  } catch {}
}, 1500).unref?.();

export async function approveAndPublishDraft(
  draftId: string,
  commandContext = 'اعتماد ونشر مسودة التفاعلات',
  intervalSecondsOverride?: number
): Promise<{ draft: AiAssistantDraft; publishedMessages: ChannelMessage[]; scheduled: boolean }> {
  const store = getAiAssistantDiskStore();
  const draft = store.drafts?.[draftId] as AiAssistantDraft | undefined;
  if (!draft) {
    throw new Error('لم يتم العثور على مسودة التفاعلات المطلوبة.');
  }
  if (draft.status !== 'pending_approval') {
    if (draft.status === 'publishing') {
      throw new Error('هذه المسودة قيد النشر المجدول حالياً.');
    }
    throw new Error(draft.status === 'published' ? 'تم نشر هذه المسودة مسبقاً.' : 'تم إلغاء هذه المسودة.');
  }
  const channel = await getChannelById(draft.channelId);
  if (!channel) {
    throw new Error(`القناة المستهدفة (${draft.channelName}) غير موجودة.`);
  }

  const safeInterval = clampIntervalSeconds(
    intervalSecondsOverride !== undefined ? intervalSecondsOverride : draft.intervalSeconds
  );
  const baseTs = Date.now();
  const publishedMessages: ChannelMessage[] = [];

  if (safeInterval > 0 && draft.items.length > 1) {
    const firstItem = draft.items[0];
    const firstMsg = buildVirtualPersonaChannelMessage(draft, channel.id, firstItem, 0, baseTs);
    await saveChannelMessage(firstMsg);
    publishedMessages.push(firstMsg);

    const nextPublishAt = Date.now() + safeInterval * 1000;
    const updatedDraft: AiAssistantDraft = {
      ...draft,
      status: 'publishing',
      intervalSeconds: safeInterval,
      publishedCount: 1,
      nextPublishAt,
      updatedAt: Date.now(),
    };
    store.drafts![draft.id] = updatedDraft;
    saveAiAssistantDiskStore();
    await tryWriteFirestoreDoc('ai_assistant_drafts', updatedDraft.id, updatedDraft);

    await appendAuditLog({
      actionType: 'publish_virtual_personas',
      command: commandContext,
      target: `${channel.name} (${channel.id})`,
      status: 'pending',
      details: `بدأ النشر المجدول (1/${draft.items.length}) كل ${safeInterval} ثانية حول: ${draft.topic}`,
    });

    dispatchAuthorizedChatPush({
      senderId: firstMsg.senderId,
      senderName: firstMsg.senderName,
      senderRole: 'user',
      title: `💬 ${channel.name}`,
      chatType: 'channel',
      channelId: channel.id,
      messageId: firstMsg.id,
      snippet: firstMsg.text || 'تفاعل جديد في القناة',
    }).catch(() => {});

    scheduleDraftTimer(updatedDraft.id);
    return { draft: updatedDraft, publishedMessages, scheduled: true };
  }

  for (let i = 0; i < draft.items.length; i++) {
    const item = draft.items[i];
    const msg = buildVirtualPersonaChannelMessage(draft, channel.id, item, i, baseTs + i * 1000);
    await saveChannelMessage(msg);
    publishedMessages.push(msg);
  }

  const updatedDraft: AiAssistantDraft = {
    ...draft,
    status: 'published',
    intervalSeconds: 0,
    nextPublishAt: null,
    publishedCount: publishedMessages.length,
    updatedAt: Date.now(),
  };
  store.drafts![draft.id] = updatedDraft;
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_drafts', updatedDraft.id, updatedDraft);

  await appendAuditLog({
    actionType: 'publish_virtual_personas',
    command: commandContext,
    target: `${channel.name} (${channel.id})`,
    status: 'success',
    details: `تم نشر ${publishedMessages.length} تفاعلات لشخصيات افتراضية حول: ${draft.topic}`,
  });

  if (publishedMessages.length > 0) {
    const last = publishedMessages[publishedMessages.length - 1];
    dispatchAuthorizedChatPush({
      senderId: last.senderId,
      senderName: last.senderName,
      senderRole: 'user',
      title: `💬 ${channel.name}`,
      chatType: 'channel',
      channelId: channel.id,
      messageId: last.id,
      snippet: last.text || 'تفاعل جديد في القناة',
    }).catch(() => {});
  }

  return { draft: updatedDraft, publishedMessages, scheduled: false };
}

export async function updateDraftItems(
  draftId: string,
  items: VirtualPersonaDraftItem[],
  intervalSeconds?: number
): Promise<AiAssistantDraft> {
  const store = getAiAssistantDiskStore();
  const draft = store.drafts?.[draftId] as AiAssistantDraft | undefined;
  if (!draft) throw new Error('المسودة غير موجودة.');
  if (draft.status !== 'pending_approval') {
    throw new Error('لا يمكن تعديل مسودة منشورة أو قيد النشر أو ملغاة.');
  }
  const cleaned: VirtualPersonaDraftItem[] = (Array.isArray(items) ? items : [])
    .map((it, idx) => ({
      id: String(it.id || `vp_${idx + 1}`),
      personaName: sanitizeNoBannedAiDisclaimer(String(it.personaName || `شخصية يمنية ${idx + 1}`)).slice(0, 60),
      dialect: String(it.dialect || 'يمني').slice(0, 40),
      styleTag: String(it.styleTag || 'متنوع').slice(0, 60),
      text: sanitizeNoBannedAiDisclaimer(String(it.text || '')).slice(0, 500),
    }))
    .filter((it) => it.personaName && it.text);

  if (cleaned.length === 0) {
    throw new Error('يجب أن تحتوي المسودة على تفاعل واحد صالح على الأقل.');
  }

  const nextInterval =
    intervalSeconds !== undefined
      ? clampIntervalSeconds(intervalSeconds)
      : clampIntervalSeconds(draft.intervalSeconds);

  const next: AiAssistantDraft = {
    ...draft,
    items: cleaned,
    intervalSeconds: nextInterval,
    updatedAt: Date.now(),
  };
  store.drafts![draft.id] = next;
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_drafts', next.id, next);
  return next;
}

export async function cancelDraft(draftId: string): Promise<AiAssistantDraft> {
  const store = getAiAssistantDiskStore();
  const draft = store.drafts?.[draftId] as AiAssistantDraft | undefined;
  if (!draft) throw new Error('المسودة غير موجودة.');
  if (draft.status !== 'pending_approval' && draft.status !== 'publishing') {
    throw new Error('هذه المسودة لم تعد معلقة أو قيد النشر.');
  }
  const wasPublishing = draft.status === 'publishing';
  clearDraftTimer(draftId);

  const next: AiAssistantDraft = {
    ...draft,
    status: 'cancelled',
    nextPublishAt: null,
    updatedAt: Date.now(),
  };
  store.drafts![draft.id] = next;
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_drafts', next.id, next);

  await appendAuditLog({
    actionType: 'cancel_virtual_personas',
    command: wasPublishing ? 'إيقاف النشر المجدول' : 'إلغاء مسودة التفاعلات',
    target: `${draft.channelName} (${draft.channelId})`,
    status: 'cancelled',
    details: wasPublishing
      ? `تم إيقاف النشر المجدول بعد إرسال ${draft.publishedCount || 0} من أصل ${draft.items.length} تفاعلات.`
      : `تم إلغاء المسودة (${draft.items.length} تفاعلات) قبل النشر.`,
  });

  return next;
}

export async function confirmPendingAction(
  actionId: string,
  commandContext = 'تأكيد تنفيذ الإجراء الإداري'
): Promise<{ action: AiAssistantPendingAction; navigation?: AiNavigationDirective | null }> {
  const store = getAiAssistantDiskStore();
  const action = store.pendingActions?.[actionId] as AiAssistantPendingAction | undefined;
  if (!action) throw new Error('لم يتم العثور على الإجراء المعلق.');
  if (action.status !== 'pending') {
    throw new Error(action.status === 'executed' ? 'تم تنفيذ هذا الإجراء مسبقاً.' : 'تم إلغاء هذا الإجراء مسبقاً.');
  }

  const p = action.payload || {};
  let resultMessage = '';
  let navigation: AiNavigationDirective | null = null;
  let targetDesc = action.titleAr;

  try {
    if (action.actionType === 'send_channel_message') {
      const ch = await getChannelById(String(p.channelId));
      if (!ch) throw new Error('القناة لم تعد موجودة.');
      const owner = await getUserById(OWNER_ID);
      const now = Date.now();
      const msg: ChannelMessage = {
        id: makeId('msg'),
        channelId: ch.id,
        senderId: OWNER_ID,
        senderName: owner?.displayName || 'القائد Salim',
        senderRole: 'owner',
        senderAvatarUrl: owner?.avatarUrl || null,
        text: String(p.text || ''),
        reactions: {},
        isPinned: false,
        isDeleted: false,
        timestamp: now,
      };
      await saveChannelMessage(msg);
      dispatchAuthorizedChatPush({
        senderId: OWNER_ID,
        senderName: msg.senderName,
        senderRole: 'owner',
        title: `👑 ${msg.senderName} • ${ch.name}`,
        chatType: 'channel',
        channelId: ch.id,
        messageId: msg.id,
        snippet: msg.text || 'رسالة جديدة',
      }).catch(() => {});
      resultMessage = `تم إرسال الرسالة بنجاح في قناة «${ch.name}».`;
      targetDesc = `${ch.name} (${ch.id})`;
      navigation = { tab: 'channels', channelId: ch.id, channelName: ch.name, messageId: msg.id };
    } else if (action.actionType === 'send_private_message') {
      const targetUser = await getUserById(Number(p.receiverId));
      if (!targetUser) throw new Error('المستخدم المستلم غير موجود.');
      const owner = await getUserById(OWNER_ID);
      const now = Date.now();
      const id = makeId('pm');
      const convId = [OWNER_ID, targetUser.id].sort((a, b) => a - b).join('_');
      await savePrivateMessageRecord({
        id,
        conversationId: convId,
        senderId: OWNER_ID,
        receiverId: targetUser.id,
        senderName: owner?.displayName || 'القائد Salim',
        senderRole: 'owner',
        senderAvatarUrl: owner?.avatarUrl || null,
        text: String(p.text || ''),
        timestamp: now,
        isPinned: false,
        reactions: {},
      });
      dispatchAuthorizedChatPush({
        senderId: OWNER_ID,
        senderName: owner?.displayName || 'القائد Salim',
        senderRole: 'owner',
        title: `👑 رسالة خاصة من القائد Salim`,
        chatType: 'private',
        receiverId: targetUser.id,
        partnerId: OWNER_ID,
        targetUserIds: [targetUser.id],
        messageId: id,
        snippet: String(p.text || ''),
      }).catch(() => {});
      resultMessage = `تم إرسال الرسالة الخاصة إلى ${targetUser.displayName} (@${targetUser.username}) بنجاح.`;
      targetDesc = `${targetUser.username} (#${targetUser.id})`;
      navigation = { tab: 'private_chat', partnerId: targetUser.id, partnerName: targetUser.displayName, messageId: id };
    } else if (action.actionType === 'create_channel') {
      const now = Date.now();
      const visibility = p.visibility === 'hidden' ? 'hidden' : 'visible';
      const isOpenPublic = visibility !== 'hidden' && Boolean(p.isOpenPublic);
      const ch: ChannelRecord = {
        id: `channel_${now}_${crypto.randomBytes(3).toString('hex')}`,
        name: String(p.name || 'قناة جديدة').trim(),
        description: String(p.description || '').trim(),
        visibility: visibility as 'visible' | 'hidden',
        isOpenPublic,
        isPrivate: !isOpenPublic,
        password: isOpenPublic ? '' : String(p.password || '').trim(),
        allowedMemberIds: [OWNER_ID],
        memberIds: [OWNER_ID],
        createdAt: now,
        updatedAt: now,
      };
      await saveChannelRecord(ch);
      await updateThreadContext({ activeChannelId: ch.id, activeChannelName: ch.name });
      resultMessage = `تم إنشاء القناة الجديدة «${ch.name}» بنجاح (${ch.isOpenPublic ? 'مفتوحة للجميع' : ch.visibility === 'hidden' ? 'مخفية' : 'مغلقة بكلمة مرور'}).`;
      targetDesc = `${ch.name} (${ch.id})`;
      navigation = { tab: 'channels', channelId: ch.id, channelName: ch.name };
    } else if (action.actionType === 'update_channel') {
      const ch = await getChannelById(String(p.channelId));
      if (!ch) throw new Error('القناة المطلوب تعديلها غير موجودة.');
      const nextVis = p.visibility !== undefined ? (p.visibility === 'hidden' ? 'hidden' : 'visible') : ch.visibility;
      const nextOpen = nextVis === 'hidden' ? false : p.isOpenPublic !== undefined ? Boolean(p.isOpenPublic) : Boolean(ch.isOpenPublic);
      const nextPwd = nextOpen ? '' : p.password !== undefined ? String(p.password).trim() : ch.password || '';
      const updated: ChannelRecord = {
        ...ch,
        name: p.name !== undefined ? String(p.name).trim() : ch.name,
        description: p.description !== undefined ? String(p.description) : ch.description,
        visibility: nextVis as 'visible' | 'hidden',
        isOpenPublic: nextOpen,
        isPrivate: !nextOpen,
        password: nextPwd,
        updatedAt: Date.now(),
      };
      await saveChannelRecord(updated);
      await updateThreadContext({ activeChannelId: updated.id, activeChannelName: updated.name });
      resultMessage = `تم تحديث إعدادات قناة «${updated.name}» بنجاح.`;
      targetDesc = `${updated.name} (${updated.id})`;
      navigation = { tab: 'channels', channelId: updated.id, channelName: updated.name };
    } else if (action.actionType === 'delete_channel') {
      const chId = String(p.channelId);
      const chName = String(p.channelName || chId);
      await deleteChannelRecord(chId);
      const thread = ensureThread();
      if (thread.activeChannelId === chId) {
        await updateThreadContext({ activeChannelId: null, activeChannelName: null });
      }
      resultMessage = `تم حذف قناة «${chName}» نهائياً.`;
      targetDesc = `${chName} (${chId})`;
    } else if (action.actionType === 'manage_channel_members') {
      const chId = String(p.channelId);
      const uid = Number(p.userId);
      const uname = String(p.userDisplayName || `#${uid}`);
      if (p.operation === 'remove') {
        await removeChannelMember(chId, uid);
        resultMessage = `تمت إزالة العضو ${uname} من قناة «${p.channelName}».`;
      } else {
        await addChannelMembers(chId, [uid]);
        resultMessage = `تمت إضافة العضو ${uname} إلى قائمة المصرح لهم في قناة «${p.channelName}».`;
      }
      targetDesc = `${p.channelName} -> ${uname}`;
    } else if (action.actionType === 'manage_user') {
      const uid = Number(p.userId);
      const uname = String(p.userDisplayName || `#${uid}`);
      if (uid === OWNER_ID) {
        throw new Error('لا يمكن تعديل رتبة أو حذف حساب المالك الرئيسي.');
      }
      if (p.operation === 'delete_user') {
        await deleteUserRecord(uid);
        resultMessage = `تم حذف حساب المستخدم ${uname} (#${uid}) بنجاح.`;
      } else {
        const nextRole = p.role === 'moderator' ? 'moderator' : 'user';
        await updateUserRecord(uid, { role: nextRole });
        resultMessage = `تم تحديث رتبة ${uname} إلى ${nextRole === 'moderator' ? 'مشرف' : 'عضو'}.`;
      }
      targetDesc = `${uname} (#${uid})`;
    } else if (action.actionType === 'pin_channel_message') {
      const pinned = await togglePinChannelMessage(String(p.channelId), String(p.messageId));
      resultMessage = pinned
        ? `تم تثبيت الرسالة (${p.messageId}) في قناة «${p.channelName}».`
        : `تم إلغاء تثبيت الرسالة (${p.messageId}) في قناة «${p.channelName}».`;
      targetDesc = `${p.channelName} (${p.messageId})`;
    }
  } catch (err: any) {
    await appendAuditLog({
      actionType: action.actionType,
      command: commandContext,
      target: targetDesc,
      status: 'error',
      details: err?.message || 'فشل تنفيذ الإجراء.',
    });
    throw err;
  }

  const nextAction: AiAssistantPendingAction = {
    ...action,
    status: 'executed',
    resultMessage,
    updatedAt: Date.now(),
  };
  store.pendingActions![action.id] = nextAction;
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_pending_actions', nextAction.id, nextAction);

  await appendAuditLog({
    actionType: action.actionType,
    command: commandContext,
    target: targetDesc,
    status: 'success',
    details: resultMessage,
  });

  return { action: nextAction, navigation };
}

export async function cancelPendingAction(actionId: string): Promise<AiAssistantPendingAction> {
  const store = getAiAssistantDiskStore();
  const action = store.pendingActions?.[actionId] as AiAssistantPendingAction | undefined;
  if (!action) throw new Error('لم يتم العثور على الإجراء المعلق.');
  if (action.status !== 'pending') {
    throw new Error('هذا الإجراء لم يعد معلقاً.');
  }
  const next: AiAssistantPendingAction = {
    ...action,
    status: 'cancelled',
    resultMessage: 'تم إلغاء الإجراء بناءً على طلب المالك.',
    updatedAt: Date.now(),
  };
  store.pendingActions![action.id] = next;
  saveAiAssistantDiskStore();
  await tryWriteFirestoreDoc('ai_assistant_pending_actions', next.id, next);

  await appendAuditLog({
    actionType: action.actionType,
    command: 'إلغاء إجراء معلق',
    target: action.titleAr,
    status: 'cancelled',
    details: action.summaryAr,
  });

  return next;
}

export async function resetOwnerAiConversation(): Promise<void> {
  const store = getAiAssistantDiskStore();
  const prevMsgs = [...(store.messages || [])];
  store.messages = [];
  saveAiAssistantDiskStore();
  for (const m of prevMsgs) {
    if (m?.id) void tryDeleteFirestoreDoc('ai_assistant_messages', m.id);
  }
  await updateThreadContext({
    activeSection: 'ai_assistant',
    activeChannelId: null,
    activeChannelName: null,
    activePartnerId: null,
  });
  await appendAuditLog({
    actionType: 'reset_conversation',
    command: 'مسح سجل محادثة المساعد الذكي',
    target: OWNER_THREAD_ID,
    status: 'success',
    details: 'تم بدء جلسة محادثة جديدة ونظيفة للمالك سليم.',
  });
}

function getLatestPending(turnStartedAt: number): { draft: AiAssistantDraft | null; action: AiAssistantPendingAction | null } {
  const store = getAiAssistantDiskStore();
  const drafts = Object.values(store.drafts || {})
    .filter((d: any) => d?.status === 'pending_approval' && d.createdAt < turnStartedAt)
    .sort((a: any, b: any) => b.createdAt - a.createdAt) as AiAssistantDraft[];
  const actions = Object.values(store.pendingActions || {})
    .filter((a: any) => a?.status === 'pending' && a.createdAt < turnStartedAt)
    .sort((a: any, b: any) => b.createdAt - a.createdAt) as AiAssistantPendingAction[];
  return { draft: drafts[0] || null, action: actions[0] || null };
}

export async function processOwnerAiChat(userText: string): Promise<{
  userMessage: AiAssistantMessage;
  assistantMessage: AiAssistantMessage;
  thread: AiAssistantThread;
  activeDraft: AiAssistantDraft | null;
  activePendingAction: AiAssistantPendingAction | null;
}> {
  const cleanInput = String(userText || '').trim();
  if (!cleanInput) {
    throw new Error('الرسالة فارغة.');
  }

  const ai = getGeminiClient();
  const turnStartedAt = Date.now();

  const userMessage = await appendChatMessage({
    role: 'user',
    text: cleanInput,
    timestamp: turnStartedAt,
  });

  const store = getAiAssistantDiskStore();
  let thread = ensureThread();

  const historyMsgs = (store.messages || []).slice(-22, -1);
  const prePending = getLatestPending(turnStartedAt);

  const contents: Content[] = historyMsgs.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.text }],
  }));
  contents.push({
    role: 'user',
    parts: [{ text: cleanInput }],
  });

  const toolSteps: AiToolStep[] = [];
  let createdDraftId: string | null = null;
  let createdPendingActionId: string | null = null;
  let navigationDirective: AiNavigationDirective | null = null;

  let finalText = '';
  const MAX_TOOL_ROUNDS = 6;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents,
      config: {
        systemInstruction: buildSystemInstruction(thread, prePending.draft, prePending.action),
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      },
    });

    const fnCalls = response.functionCalls;
    const candidateContent = response.candidates?.[0]?.content;

    if (!fnCalls || fnCalls.length === 0) {
      finalText = sanitizeNoBannedAiDisclaimer(response.text || '');
      break;
    }

    if (candidateContent) {
      contents.push(candidateContent);
    }

    const fnResponseParts: any[] = [];

    for (const call of fnCalls) {
      const name = String(call.name || '');
      const args = (call.args || {}) as Record<string, any>;
      let toolResult: Record<string, any> = {};

      try {
        if (name === 'list_channels') {
          const chs = await getChannelsForUser(OWNER_ID, 'owner');
          const summary = chs.map((c) => ({
            id: c.id,
            name: c.name,
            description: c.description,
            visibility: c.visibility,
            isOpenPublic: Boolean(c.isOpenPublic || (!c.isPrivate && !c.password)),
            memberCount: c.displayMemberCount ?? (c.memberIds?.length || c.allowedMemberIds?.length || 1),
          }));
          toolSteps.push({
            toolName: name,
            labelAr: 'استعراض القنوات',
            status: 'ok',
            summaryAr: `تم جلب ${summary.length} قناة.`,
          });
          toolResult = { channels: summary };
        } else if (name === 'navigate_app') {
          const validSections = ['dashboard', 'channels', 'private_chat', 'admin', 'history', 'roadmap', 'settings', 'ai_assistant'];
          const section = validSections.includes(String(args.section)) ? String(args.section) : 'channels';
          let targetChannel: ChannelRecord | null = null;
          let targetPartner: { id: number; username: string; displayName: string; role: string } | null = null;

          if (args.channelQuery) {
            targetChannel = await resolveChannelTarget(String(args.channelQuery), thread);
          } else if (section === 'channels') {
            targetChannel = await resolveChannelTarget(null, thread);
          }

          if (args.partnerQuery) {
            targetPartner = await resolveUserTarget(String(args.partnerQuery));
          }

          const nav: AiNavigationDirective = {
            tab: (targetChannel ? 'channels' : targetPartner ? 'private_chat' : section) as AiNavigationDirective['tab'],
            channelId: targetChannel?.id || null,
            channelName: targetChannel?.name || null,
            partnerId: targetPartner?.id || null,
            partnerName: targetPartner?.displayName || null,
          };
          navigationDirective = nav;
          thread = await updateThreadContext({
            activeSection: nav.tab,
            activeChannelId: targetChannel ? targetChannel.id : thread.activeChannelId,
            activeChannelName: targetChannel ? targetChannel.name : thread.activeChannelName,
            activePartnerId: targetPartner ? targetPartner.id : thread.activePartnerId,
          });
          await appendAuditLog({
            actionType: 'navigate_app',
            command: cleanInput,
            target: targetChannel ? `${targetChannel.name} (${targetChannel.id})` : nav.tab,
            status: 'success',
            details: `تم تحديث السياق والانتقال إلى ${targetChannel ? `قناة ${targetChannel.name}` : nav.tab}.`,
          });
          toolSteps.push({
            toolName: name,
            labelAr: targetChannel ? `التوجه إلى «${targetChannel.name}»` : `الانتقال إلى ${nav.tab}`,
            status: 'ok',
            summaryAr: targetChannel ? `القناة النشطة الآن: ${targetChannel.name}` : `القسم النشط: ${nav.tab}`,
          });
          toolResult = { navigated: true, navigation: nav };
        } else if (name === 'read_channel_messages') {
          const ch = await resolveChannelTarget(args.channelQuery, thread);
          if (!ch) {
            toolSteps.push({
              toolName: name,
              labelAr: 'قراءة رسائل القناة',
              status: 'error',
              summaryAr: 'لم يتم تحديد قناة صالحة.',
            });
            toolResult = { error: 'لم يتم العثور على القناة المطلوبة. حدد اسم القناة أو استعرض القنوات أولاً.' };
          } else {
            const limit = Math.max(1, Math.min(50, Number(args.limit) || 15));
            const msgs = await getChannelMessages(ch.id, limit);
            thread = await updateThreadContext({ activeChannelId: ch.id, activeChannelName: ch.name });
            const items = msgs.map((m) => ({
              id: m.id,
              senderId: m.senderId,
              senderName: m.senderName,
              senderRole: m.senderRole,
              isVirtualPersona: Boolean(m.isVirtualPersona || m.senderRole === 'virtual_persona'),
              text: m.text || (m.imageUrl ? '[صورة]' : m.audioUrl ? '[رسالة صوتية]' : m.fileName ? `[ملف: ${m.fileName}]` : ''),
              timestamp: m.timestamp,
              isPinned: Boolean(m.isPinned),
            }));
            await appendAuditLog({
              actionType: 'read_channel_messages',
              command: cleanInput,
              target: `${ch.name} (${ch.id})`,
              status: 'success',
              details: `قراءة آخر ${items.length} رسائل في القناة.`,
            });
            toolSteps.push({
              toolName: name,
              labelAr: `قراءة رسائل «${ch.name}»`,
              status: 'ok',
              summaryAr: `تمت قراءة ${items.length} رسالة.`,
            });
            toolResult = { channelId: ch.id, channelName: ch.name, messages: items };
          }
        } else if (name === 'list_users') {
          const all = await getAllUsersList();
          const q = args.search ? normalizeArabicForMatch(String(args.search)) : '';
          const filtered = q
            ? all.filter(
                (u) =>
                  normalizeArabicForMatch(u.username).includes(q) ||
                  normalizeArabicForMatch(u.displayName).includes(q)
              )
            : all;
          const list = filtered.slice(0, 60).map((u) => ({
            id: u.id,
            username: u.username,
            displayName: u.displayName,
            role: u.role,
            isRestrictedAdmin: Boolean(u.isRestrictedAdmin),
          }));
          toolSteps.push({
            toolName: name,
            labelAr: 'جلب قائمة المستخدمين',
            status: 'ok',
            summaryAr: `تم العثور على ${list.length} مستخدم.`,
          });
          toolResult = { total: filtered.length, users: list };
        } else if (name === 'read_user_challenge_and_trades') {
          const u = args.userQuery ? await resolveUserTarget(String(args.userQuery)) : await getUserById(OWNER_ID);
          if (!u) {
            toolResult = { error: 'المستخدم غير موجود.' };
          } else {
            const challenge = await getUserChallenge(u.id, u.displayName);
            const trades = await getUserTrades(u.id);
            toolSteps.push({
              toolName: name,
              labelAr: `قراءة تحدي وصفقات ${u.displayName}`,
              status: 'ok',
              summaryAr: `${trades.length} صفقة، الرصيد ${(challenge.currentBalanceCents / 100).toFixed(2)}$`,
            });
            toolResult = {
              user: { id: u.id, username: u.username, displayName: u.displayName },
              challenge: {
                initialCapitalUsd: challenge.initialCapitalCents / 100,
                currentBalanceUsd: challenge.currentBalanceCents / 100,
                targetBalanceUsd: challenge.targetBalanceCents / 100,
                tradeCount: challenge.tradeCount,
                started: challenge.challengeStarted,
              },
              recentTrades: trades.slice(-15),
            };
          }
        } else if (name === 'prepare_virtual_persona_interactions') {
          const ch = await resolveChannelTarget(args.channelQuery || 'القناة العامة', thread);
          if (!ch) {
            toolSteps.push({
              toolName: name,
              labelAr: 'إعداد شخصيات افتراضية',
              status: 'error',
              summaryAr: 'لم يتم العثور على القناة المستهدفة.',
            });
            toolResult = { error: 'لم يتم العثور على القناة المستهدفة.' };
          } else {
            const count = Math.max(1, Math.min(30, Math.floor(Number(args.count) || 5)));
            const intervalSeconds = clampIntervalSeconds(args.intervalSeconds);
            const topic = String(args.topic || 'تفاعل إيجابي حول الصفقة').trim();
            const recentMsgs = await getChannelMessages(ch.id, 10);
            const sampleTexts = recentMsgs.map((m) => m.text).filter((x): x is string => Boolean(x));

            const items = await generateDiverseVirtualPersonas({
              topic,
              count,
              channelName: ch.name,
              recentMessagesSample: sampleTexts,
            });

            const now = Date.now();
            const draft: AiAssistantDraft = {
              id: makeId('aidraft'),
              ownerId: OWNER_ID,
              ownerUsername: OWNER_USERNAME,
              channelId: ch.id,
              channelName: ch.name,
              topic,
              status: 'pending_approval',
              items,
              intervalSeconds,
              nextPublishAt: null,
              createdAt: now,
              updatedAt: now,
            };
            store.drafts![draft.id] = draft;
            saveAiAssistantDiskStore();
            await tryWriteFirestoreDoc('ai_assistant_drafts', draft.id, draft);

            createdDraftId = draft.id;
            thread = await updateThreadContext({
              activeChannelId: ch.id,
              activeChannelName: ch.name,
            });

            await appendAuditLog({
              actionType: 'prepare_virtual_personas',
              command: cleanInput,
              target: `${ch.name} (${ch.id})`,
              status: 'pending',
              details: `تم إعداد مسودة ${items.length} تفاعلات يمنية افتراضية حول "${topic}"${intervalSeconds > 0 ? ` (بفاصل ${intervalSeconds} ثانية بين كل رسالة)` : ''} بانتظار اعتماد المالك.`,
            });

            toolSteps.push({
              toolName: name,
              labelAr: `إعداد ${items.length} تفاعلات لقناة «${ch.name}»`,
              status: 'pending_confirmation',
              summaryAr:
                intervalSeconds > 0
                  ? `جاهزة للمراجعة (بفاصل ${intervalSeconds} ثانية بين كل رسالة).`
                  : 'جاهزة للمراجعة والاعتماد قبل النشر.',
            });

            toolResult = {
              status: 'pending_approval',
              draftId: draft.id,
              channelId: ch.id,
              channelName: ch.name,
              topic,
              intervalSeconds,
              count: items.length,
              items: items.map((it, idx) => ({
                index: idx + 1,
                personaName: it.personaName,
                dialect: it.dialect,
                text: it.text,
              })),
            };
          }
        } else if (name === 'confirm_pending') {
          const decision = String(args.decision || 'approve').toLowerCase();
          const targetId = args.targetId ? String(args.targetId) : '';
          const targetDraft =
            (targetId ? store.drafts?.[targetId] : null) || prePending.draft;
          const targetAction =
            (targetId ? store.pendingActions?.[targetId] : null) || prePending.action;

          if (targetDraft && targetDraft.status === 'pending_approval' && targetDraft.createdAt < turnStartedAt) {
            if (decision === 'cancel') {
              const cancelled = await cancelDraft(targetDraft.id);
              toolSteps.push({
                toolName: name,
                labelAr: 'إلغاء مسودة التفاعلات',
                status: 'ok',
                summaryAr: `تم إلغاء المسودة (${cancelled.items.length} تفاعلات).`,
              });
              toolResult = { cancelled: true, draftId: cancelled.id };
            } else {
              const intervalOverride =
                args.intervalSeconds !== undefined ? clampIntervalSeconds(args.intervalSeconds) : undefined;
              const res = await approveAndPublishDraft(targetDraft.id, cleanInput, intervalOverride);
              navigationDirective = {
                tab: 'channels',
                channelId: res.draft.channelId,
                channelName: res.draft.channelName,
                messageId: res.publishedMessages[res.publishedMessages.length - 1]?.id || null,
              };
              const usedInterval = res.draft.intervalSeconds || 0;
              toolSteps.push({
                toolName: name,
                labelAr: res.scheduled
                  ? `بدء النشر المجدول (${res.draft.items.length})`
                  : `نشر ${res.publishedMessages.length} تفاعلات`,
                status: 'ok',
                summaryAr: res.scheduled
                  ? `تم إرسال الأولى في «${res.draft.channelName}» وتُرسل البقية كل ${usedInterval} ثانية.`
                  : `تم النشر في «${res.draft.channelName}».`,
              });
              toolResult = {
                published: !res.scheduled,
                scheduled: res.scheduled,
                intervalSeconds: usedInterval,
                draftId: res.draft.id,
                channelId: res.draft.channelId,
                channelName: res.draft.channelName,
                totalCount: res.draft.items.length,
                publishedCount: res.publishedMessages.length,
              };
            }
          } else if (targetAction && targetAction.status === 'pending' && targetAction.createdAt < turnStartedAt) {
            if (decision === 'cancel') {
              const cancelled = await cancelPendingAction(targetAction.id);
              toolSteps.push({
                toolName: name,
                labelAr: 'إلغاء الإجراء المعلق',
                status: 'ok',
                summaryAr: cancelled.titleAr,
              });
              toolResult = { cancelled: true, actionId: cancelled.id };
            } else {
              const res = await confirmPendingAction(targetAction.id, cleanInput);
              if (res.navigation) navigationDirective = res.navigation;
              toolSteps.push({
                toolName: name,
                labelAr: res.action.titleAr,
                status: 'ok',
                summaryAr: res.action.resultMessage || 'تم التنفيذ.',
              });
              toolResult = { executed: true, actionId: res.action.id, resultMessage: res.action.resultMessage };
            }
          } else {
            toolResult = {
              error: 'لا توجد مسودة أو إجراء معلق من رسالة سابقة لتأكيده. يجب عرض المسودة للمالك أولاً ثم تأكيدها في رسالة تالية أو عبر زر الاعتماد.',
            };
          }
        } else if (name === 'propose_channel_message') {
          const ch = await resolveChannelTarget(args.channelQuery, thread);
          if (!ch) {
            toolResult = { error: 'لم يتم تحديد قناة صالحة.' };
          } else {
            const now = Date.now();
            const text = sanitizeNoBannedAiDisclaimer(String(args.text || ''));
            const action: AiAssistantPendingAction = {
              id: makeId('aiact'),
              ownerId: OWNER_ID,
              ownerUsername: OWNER_USERNAME,
              actionType: 'send_channel_message',
              titleAr: `إرسال رسالة إلى قناة «${ch.name}»`,
              summaryAr: `سيتم نشر الرسالة التالية باسم القائد Salim في «${ch.name}»:\n"${text}"`,
              payload: { channelId: ch.id, channelName: ch.name, text },
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            };
            store.pendingActions![action.id] = action;
            saveAiAssistantDiskStore();
            await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);
            createdPendingActionId = action.id;
            thread = await updateThreadContext({ activeChannelId: ch.id, activeChannelName: ch.name });
            await appendAuditLog({
              actionType: action.actionType,
              command: cleanInput,
              target: `${ch.name} (${ch.id})`,
              status: 'pending',
              details: `بانتظار تأكيد المالك لإرسال رسالة قناة.`,
            });
            toolSteps.push({
              toolName: name,
              labelAr: action.titleAr,
              status: 'pending_confirmation',
              summaryAr: 'بانتظار موافقة المالك.',
            });
            toolResult = { pendingConfirmation: true, actionId: action.id, summaryAr: action.summaryAr };
          }
        } else if (name === 'propose_private_message') {
          const u = await resolveUserTarget(String(args.userQuery || ''));
          if (!u) {
            toolResult = { error: 'لم يتم العثور على المستخدم المستهدف.' };
          } else {
            const now = Date.now();
            const text = sanitizeNoBannedAiDisclaimer(String(args.text || ''));
            const action: AiAssistantPendingAction = {
              id: makeId('aiact'),
              ownerId: OWNER_ID,
              ownerUsername: OWNER_USERNAME,
              actionType: 'send_private_message',
              titleAr: `إرسال رسالة خاصة إلى ${u.displayName}`,
              summaryAr: `سيتم إرسال رسالة خاصة من القائد Salim إلى ${u.displayName} (@${u.username}):\n"${text}"`,
              payload: { receiverId: u.id, receiverUsername: u.username, receiverDisplayName: u.displayName, text },
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            };
            store.pendingActions![action.id] = action;
            saveAiAssistantDiskStore();
            await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);
            createdPendingActionId = action.id;
            await appendAuditLog({
              actionType: action.actionType,
              command: cleanInput,
              target: `${u.username} (#${u.id})`,
              status: 'pending',
              details: 'بانتظار تأكيد المالك لإرسال رسالة خاصة.',
            });
            toolSteps.push({
              toolName: name,
              labelAr: action.titleAr,
              status: 'pending_confirmation',
              summaryAr: 'بانتظار موافقة المالك.',
            });
            toolResult = { pendingConfirmation: true, actionId: action.id, summaryAr: action.summaryAr };
          }
        } else if (name === 'propose_create_channel') {
          const now = Date.now();
          const chName = String(args.name || '').trim();
          if (!chName) {
            toolResult = { error: 'اسم القناة مطلوب.' };
          } else {
            const visibility = args.visibility === 'hidden' ? 'hidden' : 'visible';
            const isOpenPublic = visibility !== 'hidden' && Boolean(args.isOpenPublic);
            const action: AiAssistantPendingAction = {
              id: makeId('aiact'),
              ownerId: OWNER_ID,
              ownerUsername: OWNER_USERNAME,
              actionType: 'create_channel',
              titleAr: `إنشاء قناة جديدة: «${chName}»`,
              summaryAr: `النوع: ${isOpenPublic ? 'مفتوحة للعامة' : visibility === 'hidden' ? 'مخفية للأعضاء فقط' : 'مغلقة بكلمة مرور'}`,
              payload: {
                name: chName,
                description: String(args.description || '').trim(),
                visibility,
                isOpenPublic,
                password: isOpenPublic ? '' : String(args.password || '').trim(),
              },
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            };
            store.pendingActions![action.id] = action;
            saveAiAssistantDiskStore();
            await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);
            createdPendingActionId = action.id;
            await appendAuditLog({
              actionType: action.actionType,
              command: cleanInput,
              target: chName,
              status: 'pending',
              details: 'بانتظار تأكيد المالك لإنشاء قناة.',
            });
            toolSteps.push({
              toolName: name,
              labelAr: action.titleAr,
              status: 'pending_confirmation',
              summaryAr: 'بانتظار موافقة المالك.',
            });
            toolResult = { pendingConfirmation: true, actionId: action.id, summaryAr: action.summaryAr };
          }
        } else if (name === 'propose_update_channel') {
          const ch = await resolveChannelTarget(args.channelQuery, thread);
          if (!ch) {
            toolResult = { error: 'القناة غير موجودة.' };
          } else {
            const now = Date.now();
            const action: AiAssistantPendingAction = {
              id: makeId('aiact'),
              ownerId: OWNER_ID,
              ownerUsername: OWNER_USERNAME,
              actionType: 'update_channel',
              titleAr: `تحديث إعدادات قناة «${ch.name}»`,
              summaryAr: `سيتم تعديل إعدادات القناة «${ch.name}» وفق التغييرات المطلوبة.`,
              payload: {
                channelId: ch.id,
                channelName: ch.name,
                name: args.name,
                description: args.description,
                isOpenPublic: args.isOpenPublic,
                visibility: args.visibility,
                password: args.password,
              },
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            };
            store.pendingActions![action.id] = action;
            saveAiAssistantDiskStore();
            await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);
            createdPendingActionId = action.id;
            await appendAuditLog({
              actionType: action.actionType,
              command: cleanInput,
              target: `${ch.name} (${ch.id})`,
              status: 'pending',
              details: 'بانتظار تأكيد المالك لتعديل القناة.',
            });
            toolSteps.push({
              toolName: name,
              labelAr: action.titleAr,
              status: 'pending_confirmation',
              summaryAr: 'بانتظار موافقة المالك.',
            });
            toolResult = { pendingConfirmation: true, actionId: action.id, summaryAr: action.summaryAr };
          }
        } else if (name === 'propose_delete_channel') {
          const ch = await resolveChannelTarget(args.channelQuery, thread);
          if (!ch) {
            toolResult = { error: 'القناة غير موجودة.' };
          } else {
            const now = Date.now();
            const action: AiAssistantPendingAction = {
              id: makeId('aiact'),
              ownerId: OWNER_ID,
              ownerUsername: OWNER_USERNAME,
              actionType: 'delete_channel',
              titleAr: `حذف قناة «${ch.name}»`,
              summaryAr: `تحذير: سيتم حذف القناة «${ch.name}» (${ch.id}) نهائياً.`,
              payload: { channelId: ch.id, channelName: ch.name },
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            };
            store.pendingActions![action.id] = action;
            saveAiAssistantDiskStore();
            await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);
            createdPendingActionId = action.id;
            await appendAuditLog({
              actionType: action.actionType,
              command: cleanInput,
              target: `${ch.name} (${ch.id})`,
              status: 'pending',
              details: 'بانتظار تأكيد المالك لحذف القناة.',
            });
            toolSteps.push({
              toolName: name,
              labelAr: action.titleAr,
              status: 'pending_confirmation',
              summaryAr: 'إجراء حساس بانتظار موافقة المالك.',
            });
            toolResult = { pendingConfirmation: true, actionId: action.id, summaryAr: action.summaryAr };
          }
        } else if (name === 'propose_manage_channel_members') {
          const ch = await resolveChannelTarget(args.channelQuery, thread);
          const u = await resolveUserTarget(String(args.userQuery || ''));
          if (!ch || !u) {
            toolResult = { error: !ch ? 'القناة غير موجودة.' : 'المستخدم غير موجود.' };
          } else {
            const op = args.operation === 'remove' ? 'remove' : 'add';
            const now = Date.now();
            const action: AiAssistantPendingAction = {
              id: makeId('aiact'),
              ownerId: OWNER_ID,
              ownerUsername: OWNER_USERNAME,
              actionType: 'manage_channel_members',
              titleAr: op === 'remove' ? `إزالة ${u.displayName} من «${ch.name}»` : `إضافة ${u.displayName} إلى «${ch.name}»`,
              summaryAr:
                op === 'remove'
                  ? `سيتم سحب صلاحية وصول ${u.displayName} (@${u.username}) لقناة «${ch.name}».`
                  : `سيتم إضافة ${u.displayName} (@${u.username}) لقائمة الأعضاء المصرح لهم في قناة «${ch.name}».`,
              payload: {
                operation: op,
                channelId: ch.id,
                channelName: ch.name,
                userId: u.id,
                userDisplayName: u.displayName,
              },
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            };
            store.pendingActions![action.id] = action;
            saveAiAssistantDiskStore();
            await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);
            createdPendingActionId = action.id;
            await appendAuditLog({
              actionType: action.actionType,
              command: cleanInput,
              target: `${ch.name} / ${u.username}`,
              status: 'pending',
              details: 'بانتظار تأكيد المالك لتعديل أعضاء القناة.',
            });
            toolSteps.push({
              toolName: name,
              labelAr: action.titleAr,
              status: 'pending_confirmation',
              summaryAr: 'بانتظار موافقة المالك.',
            });
            toolResult = { pendingConfirmation: true, actionId: action.id, summaryAr: action.summaryAr };
          }
        } else if (name === 'propose_manage_user') {
          const u = await resolveUserTarget(String(args.userQuery || ''));
          if (!u) {
            toolResult = { error: 'المستخدم غير موجود.' };
          } else if (u.id === OWNER_ID) {
            toolResult = { error: 'لا يمكن تغيير دور أو حذف حساب المالك الرئيسي.' };
          } else {
            const op = args.operation === 'delete_user' ? 'delete_user' : 'set_role';
            const nextRole = args.role === 'moderator' ? 'moderator' : 'user';
            const now = Date.now();
            const action: AiAssistantPendingAction = {
              id: makeId('aiact'),
              ownerId: OWNER_ID,
              ownerUsername: OWNER_USERNAME,
              actionType: 'manage_user',
              titleAr:
                op === 'delete_user'
                  ? `حذف حساب ${u.displayName}`
                  : `تعيين ${u.displayName} كـ ${nextRole === 'moderator' ? 'مشرف' : 'عضو'}`,
              summaryAr:
                op === 'delete_user'
                  ? `تحذير: سيتم حذف المستخدم ${u.displayName} (@${u.username}) نهائياً.`
                  : `سيتم تغيير رتبة ${u.displayName} (@${u.username}) إلى ${nextRole === 'moderator' ? 'مشرف' : 'عضو'}.`,
              payload: {
                operation: op,
                userId: u.id,
                userDisplayName: u.displayName,
                role: nextRole,
              },
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            };
            store.pendingActions![action.id] = action;
            saveAiAssistantDiskStore();
            await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);
            createdPendingActionId = action.id;
            await appendAuditLog({
              actionType: action.actionType,
              command: cleanInput,
              target: `${u.username} (#${u.id})`,
              status: 'pending',
              details: 'بانتظار تأكيد المالك لإدارة المستخدم.',
            });
            toolSteps.push({
              toolName: name,
              labelAr: action.titleAr,
              status: 'pending_confirmation',
              summaryAr: 'بانتظار موافقة المالك.',
            });
            toolResult = { pendingConfirmation: true, actionId: action.id, summaryAr: action.summaryAr };
          }
        } else if (name === 'propose_pin_channel_message') {
          const ch = await resolveChannelTarget(args.channelQuery, thread);
          if (!ch) {
            toolResult = { error: 'لم يتم العثور على القناة.' };
          } else {
            const now = Date.now();
            const action: AiAssistantPendingAction = {
              id: makeId('aiact'),
              ownerId: OWNER_ID,
              ownerUsername: OWNER_USERNAME,
              actionType: 'pin_channel_message',
              titleAr: `تبديل تثبيت رسالة في «${ch.name}»`,
              summaryAr: `سيتم تثبيت أو إلغاء تثبيت الرسالة (${args.messageId}) في «${ch.name}».`,
              payload: { channelId: ch.id, channelName: ch.name, messageId: String(args.messageId) },
              status: 'pending',
              createdAt: now,
              updatedAt: now,
            };
            store.pendingActions![action.id] = action;
            saveAiAssistantDiskStore();
            await tryWriteFirestoreDoc('ai_assistant_pending_actions', action.id, action);
            createdPendingActionId = action.id;
            toolSteps.push({
              toolName: name,
              labelAr: action.titleAr,
              status: 'pending_confirmation',
              summaryAr: 'بانتظار موافقة المالك.',
            });
            toolResult = { pendingConfirmation: true, actionId: action.id, summaryAr: action.summaryAr };
          }
        } else if (name === 'get_audit_logs') {
          const lim = Math.max(1, Math.min(30, Number(args.limit) || 15));
          const logs = (store.auditLogs || []).slice(0, lim);
          toolSteps.push({
            toolName: name,
            labelAr: 'قراءة سجل التدقيق',
            status: 'ok',
            summaryAr: `عرض ${logs.length} سجل.`,
          });
          toolResult = { logs };
        } else {
          toolResult = { error: `أداة غير معروفة: ${name}` };
        }
      } catch (toolErr: any) {
        toolSteps.push({
          toolName: name,
          labelAr: name,
          status: 'error',
          summaryAr: toolErr?.message || 'خطأ غير متوقع',
        });
        toolResult = { error: toolErr?.message || 'فشل تنفيذ الأداة.' };
      }

      fnResponseParts.push({
        functionResponse: {
          id: call.id,
          name,
          response: toolResult,
        },
      });
    }

    contents.push({
      role: 'user',
      parts: fnResponseParts,
    });
  }

  if (!finalText) {
    finalText = 'تم تنفيذ المطلوب. راجع التفاصيل المعروضة أعلاه.';
  }

  const assistantMessage = await appendChatMessage({
    role: 'assistant',
    text: finalText,
    toolSteps: toolSteps.length > 0 ? toolSteps : null,
    draftId: createdDraftId,
    pendingActionId: createdPendingActionId,
    navigation: navigationDirective,
    timestamp: Date.now(),
  });

  const activeDraft = createdDraftId ? (store.drafts?.[createdDraftId] as AiAssistantDraft) || null : null;
  const activePendingAction = createdPendingActionId
    ? (store.pendingActions?.[createdPendingActionId] as AiAssistantPendingAction) || null
    : null;

  return {
    userMessage,
    assistantMessage,
    thread,
    activeDraft,
    activePendingAction,
  };
}
