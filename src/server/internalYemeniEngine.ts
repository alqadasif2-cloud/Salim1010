import crypto from 'crypto';

export interface InternalPersonaDraftItem {
  id: string;
  personaName: string;
  dialect: string;
  styleTag: string;
  text: string;
}

interface TopicContext {
  profitText: string | null;
  assetText: string | null;
  isLoss: boolean;
  isAnalysis: boolean;
  isProfit: boolean;
  channelRef: string | null;
  topicSnippet: string | null;
}

const YEMENI_PERSONA_POOL: Array<{ name: string; dialect: string; gender: 'm' | 'f' }> = [
  { name: 'أبو حمير الصنعاني', dialect: 'صنعاني', gender: 'm' },
  { name: 'بلقيس اليافعي', dialect: 'يافعي', gender: 'f' },
  { name: 'ماهر العولقي', dialect: 'حضرمي', gender: 'm' },
  { name: 'سوسن العدني', dialect: 'عدني', gender: 'f' },
  { name: 'غمدان المقطري', dialect: 'تعزي', gender: 'm' },
  { name: 'أروى الصنعاني', dialect: 'صنعاني', gender: 'f' },
  { name: 'عبده القدسي', dialect: 'تعزي', gender: 'm' },
  { name: 'سمية الحضرمي', dialect: 'حضرمي', gender: 'f' },
  { name: 'وضاح الأغبري', dialect: 'إبّي', gender: 'm' },
  { name: 'نشوان السقاف', dialect: 'عدني', gender: 'm' },
  { name: 'أمل الكميم', dialect: 'صنعاني', gender: 'f' },
  { name: 'صقر الشبواني', dialect: 'حضرمي', gender: 'm' },
  { name: 'مختار الذماري', dialect: 'صنعاني', gender: 'm' },
  { name: 'هدى البيضاني', dialect: 'إبّي', gender: 'f' },
  { name: 'طه الشرجبي', dialect: 'تعزي', gender: 'm' },
  { name: 'رضوان التهامي', dialect: 'فصحى يمنية', gender: 'm' },
  { name: 'نبيل الإرياني', dialect: 'إبّي', gender: 'm' },
  { name: 'قاسم الحميري', dialect: 'يافعي', gender: 'm' },
  { name: 'ندى العماري', dialect: 'عدني', gender: 'f' },
  { name: 'صالح باوزير', dialect: 'حضرمي', gender: 'm' },
  { name: 'فيصل الوصابي', dialect: 'إبّي', gender: 'm' },
  { name: 'مروة المخلافي', dialect: 'تعزي', gender: 'f' },
  { name: 'طلال الحاشدي', dialect: 'صنعاني', gender: 'm' },
  { name: 'ريم السالمي', dialect: 'فصحى يمنية', gender: 'f' },
  { name: 'سعيد المأربي', dialect: 'حضرمي', gender: 'm' },
  { name: 'هيثم الصلوي', dialect: 'تعزي', gender: 'm' },
  { name: 'منال اللحجي', dialect: 'عدني', gender: 'f' },
  { name: 'معاذ المطري', dialect: 'صنعاني', gender: 'm' },
  { name: 'شيماء الكاف', dialect: 'حضرمي', gender: 'f' },
  { name: 'بسام الزبيري', dialect: 'يافعي', gender: 'm' },
];

const FALLBACK_SURNAMES = [
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

function normMatch(s: string): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\u064B-\u065F]/g, '');
}

function pickRandom<T>(arr: T[]): T {
  return arr[crypto.randomInt(0, arr.length)];
}

function shuffleArr<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

function toAsciiDigits(s: string): string {
  return String(s || '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

function analyzeTopicAndChannelContext(params: {
  topic: string;
  channelName: string;
  recentMessagesSample: string[];
}): TopicContext {
  const rawTopic = toAsciiDigits(params.topic).trim();
  const normTopic = normMatch(rawTopic);
  const recentJoined = normMatch(params.recentMessagesSample.slice(-6).join(' '));

  // Extract explicit profit/number with unit so we never invent numbers
  let profitText: string | null = null;
  const dollarMatch =
    rawTopic.match(/(\d+(?:\.\d+)?)\s*(?:دولار[اً]?|دولارات|\$|usd)/i) ||
    rawTopic.match(/\$\s*(\d+(?:\.\d+)?)/i);
  const pctMatch = rawTopic.match(/(\d+(?:\.\d+)?)\s*(?:%|بالمئه|بالميه|في الميه)/i);
  const ptsMatch = rawTopic.match(/(\d+(?:\.\d+)?)\s*(?:نقطه|نقطة|نقاط|بيب|pips?)/i);

  if (dollarMatch) {
    profitText = `${dollarMatch[1]} دولار`;
  } else if (pctMatch) {
    profitText = `${pctMatch[1]}%`;
  } else if (ptsMatch) {
    profitText = `${ptsMatch[1]} نقطة`;
  }

  // Extract asset/market mentioned in topic or recent channel history
  let assetText: string | null = null;
  const combinedForAsset = `${normTopic} ${recentJoined}`;
  if (/(?:الذهب|ذهب|xau|gold)/.test(combinedForAsset)) assetText = 'الذهب';
  else if (/(?:البيتكوين|بيتكوين|btc)/.test(combinedForAsset)) assetText = 'البيتكوين';
  else if (/(?:اليورو|eurusd)/.test(combinedForAsset)) assetText = 'اليورو';
  else if (/(?:الباوند|gbpusd)/.test(combinedForAsset)) assetText = 'الباوند';
  else if (/(?:النفط|oil|wti)/.test(combinedForAsset)) assetText = 'النفط';
  else if (/(?:الناسداك|nasdaq|us100)/.test(combinedForAsset)) assetText = 'الناسداك';
  else if (/(?:الداو|us30)/.test(combinedForAsset)) assetText = 'الداو';
  else if (/(?:سكالبينج|scalping)/.test(normMatch(params.channelName))) assetText = 'السكالبينج';

  const isLoss = /(?:خساره|خسارة|ستوب|ضرب وقف|انعكاس|تراجع)/.test(normTopic);
  const isAnalysis = /(?:تحليل|توصيه|توصية|نظره|نظرة|سيناريو|تحديث|فرصه|فرصة|دخول)/.test(normTopic) && !profitText;
  const isProfit = !isLoss && (Boolean(profitText) || /(?:ربح|اهداف|أهداف|هدف|مكسب|نجاح|ضرب الهدف|حققت)/.test(normTopic));

  let topicSnippet: string | null = null;
  const cleanSnippet = rawTopic
    .replace(/^(?:صفقه|صفقة|حول|عن)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleanSnippet.length >= 6 && cleanSnippet.length <= 45) {
    topicSnippet = cleanSnippet;
  }

  return {
    profitText,
    assetText,
    isLoss,
    isAnalysis,
    isProfit,
    channelRef: params.channelName ? params.channelName.trim() : null,
    topicSnippet,
  };
}

interface DialectBank {
  shortExclaims: string[];
  openers: string[];
  profitBodies: Array<(ctx: TopicContext) => string>;
  analysisBodies: Array<(ctx: TopicContext) => string>;
  lossBodies: Array<(ctx: TopicContext) => string>;
  replyConnectors: string[];
  closings: string[];
}

const DIALECT_BANKS: Record<string, DialectBank> = {
  صنعاني: {
    shortExclaims: [
      'حيّا الله القائد سليم، شغل نظيف ومرتب',
      'سلمت يمناك يا أبو سليم، الله يفتح عليك',
      'تبارك الرحمن، قراءة رايقة للسوق اليوم',
      'ما شاء الله، دخول مضبوط وفي وقته تماماً',
    ],
    openers: [
      'حيّاكم الله يا شباب،',
      'والله يا القائد سليم،',
      'الله يبارك في جهدك يا غالي،',
      '',
      '',
    ],
    profitBodies: [
      (c) =>
        c.profitText
          ? `الـ ${c.profitText}${c.assetText ? ` في ${c.assetText}` : ''} جت على الصبر والالتزام، والحمد لله على الرزق الطيب`
          : `تحقيق الأهداف${c.assetText ? ` على ${c.assetText}` : ''} بهالشكل يثبت إن الخطة ماشية تمام`,
      (c) =>
        c.assetText
          ? `حركة ${c.assetText} اليوم كانت واضحة للي ركز، و${c.profitText ? `ربح ${c.profitText}` : 'نتيجة الصفقة'} تشرح الخاطر`
          : `صراحة إدارة الصفقة من بدايتها لنهايتها كانت موزونة جداً${c.profitText ? ` و${c.profitText} خير وبركة` : ''}`,
      (c) =>
        c.profitText
          ? `عافية عليك يا سليم، ${c.profitText} صافية وبأعصاب هادية بدون تسرع`
          : `الهدوء وقت الدخول هو سر التوفيق اليوم، ما قصرت يا قايد`,
    ],
    analysisBodies: [
      (c) =>
        `القراءة${c.assetText ? ` لحركة ${c.assetText}` : ''} منطقية جداً، خلونا نتابع الإغلاق ونلتزم بالخطة`,
      () => `تحليل رايق وواضح، أهم شي ما نستعجل ونمشي مع المستويات خطوة بخطوة`,
    ],
    lossBodies: [
      () => `السوق أخذ وعطا، وأهم شي إن الخسارة محسوبة والالتزام بالستوب حمى الحساب`,
      () => `عادي جداً يا شباب، القائد علّمنا نلتزم بالإدارة والجايات تعوّض أضعاف بإذن الله`,
    ],
    replyConnectors: [
      'فعلاً كلامك مضبوط،',
      'وأنا لاحظت نفس النقطة وقت الدخول،',
      'صدقت والله،',
      'معك حق مية بالمية،',
    ],
    closings: [
      'ربنا يبارك للجميع.',
      'بالتوفيق في الصفقات الجاية.',
      'الله يزيدك من فضله.',
      '',
      '🤲',
    ],
  },
  عدني: {
    shortExclaims: [
      'يا سلام عليك يا سليم، شغل فنان والله',
      'تمام التمام، صفقة رايقة وتستاهل',
      'تسلم يا كابتن، دايماً عند حسن الظن',
      'شغل عالي ومرتب، يعطيك العافية',
    ],
    openers: [
      'يا سلام والله،',
      'تسلم يا سليم،',
      'شوفوا يا جماعة،',
      '',
      '',
    ],
    profitBodies: [
      (c) =>
        c.profitText
          ? `${c.profitText}${c.assetText ? ` من ${c.assetText}` : ''} نتيجة تفتح النفس، والالتزام بالمستويات فرق كثير`
          : `الهدف انضرب بسلاسة${c.assetText ? ` في ${c.assetText}` : ''} وما في أحلى من الصفقة النظيفة`,
      (c) =>
        c.profitText
          ? `دخلنا على هدوء وطلعنا بـ ${c.profitText}، يعني شغل محسوب من الآخر`
          : `والله متابعة ممتازة وتوقيت الخروج كان بالملّي، ما قصرت يا كابتن`,
      (c) =>
        `الحلو في الموضوع إن كل خطوة واضحة وما فيها عشوائية${c.profitText ? `، مبروك الـ ${c.profitText}` : ''}`,
    ],
    analysisBodies: [
      (c) => `نظرة قوية${c.assetText ? ` على ${c.assetText}` : ''}، بنراقب الحركة معك أول بأول`,
      () => `كلام سليم وواضح، ننتظر تأكيد الإشارات قبل أي حركة`,
    ],
    lossBodies: [
      () => `معوضين خير إن شاء الله، السوق فرص ومثل ما نربح لازم نتقبل الستوب بروح رياضية`,
      () => `الحمد لله إن الإدارة سليمة، نرتاح شوي ونركز على الفرصة الجاية`,
    ],
    replyConnectors: [
      'والله إنك جبتها صح،',
      'نفس الكلام اللي كنت بقوله،',
      'أكيد، والتركيز هو الأساس،',
      'تمام عليك،',
    ],
    closings: [
      'ربنا يوفقنا جميعاً.',
      'مستمرين معكم بالخير.',
      'موفقين يا رب.',
      '',
      '📈',
    ],
  },
  تعزي: {
    shortExclaims: [
      'كفو والله يا سليم، بيّض الله وجهك',
      'خطوة قوية ومرتبة، بارك الله فيك',
      'الله يزيدك من فضله يا قائدنا',
      'شغل متعوب عليه، عاشت الأيادي',
    ],
    openers: [
      'والله كفو يا سليم،',
      'أحسنت يا بطل،',
      'حقيقة يا إخوان،',
      '',
      '',
    ],
    profitBodies: [
      (c) =>
        c.profitText
          ? `تحقيق ${c.profitText}${c.assetText ? ` على ${c.assetText}` : ''} يبرهن إن الصبر مع التحليل الدقيق ما يضيع`
          : `الالتزام بالأهداف جاب نتيجة ترفع الرأس${c.assetText ? ` في ${c.assetText}` : ''}`,
      (c) =>
        c.assetText
          ? `تابعنا ${c.assetText} خطوة بخطوة مع القائد والنتيجة${c.profitText ? ` (${c.profitText})` : ''} كانت مستحقة بجدارة`
          : `تنظيم ممتاز للصفقة من نقطة الدخول لين حجز الربح${c.profitText ? ` بـ ${c.profitText}` : ''}`,
      (c) =>
        c.profitText
          ? `ربح ${c.profitText} خطوة طيبة في مسار التحدي، والأهم الاستمرار بنفس الانضباط`
          : `انضباط ممتاز وثبات على الخطة من البداية للنهاية`,
    ],
    analysisBodies: [
      (c) => `توجيه ممتاز${c.assetText ? ` في ${c.assetText}` : ''}، والوضوح في الشرح يريح المتابعين`,
      () => `رؤية موفقة ومقنعة، ننتظر تفاعل السعر عند المناطق المحددة`,
    ],
    lossBodies: [
      () => `ما عليه يا قائد، الانضباط في وقف الخسارة هو اللي يحافظ على رأس المال للفرص الأقوى`,
      () => `التزامنا بالخطة أهم من صفقة واحدة، وربنا يعوّضنا بالأحسن`,
    ],
    replyConnectors: [
      'نعم بالضبط،',
      'وأزيد على كلامك إن',
      'فعلاً نقطة مهمة جداً،',
      'أتفق معك تماماً،',
    ],
    closings: [
      'دمت متألقاً يا سليم.',
      'ربي يبارك لنا ولكم.',
      'إلى الأمام دائماً.',
      '',
      '✨',
    ],
  },
  حضرمي: {
    shortExclaims: [
      'بارك الله فيك يا أبو سليم، خير وبركة',
      'طرح طيب ومبارك، ما قصرت يا غالي',
      'الله يرزقنا وإياكم الرزق الحلال الطيب',
      'نتيجة طيبة وتستاهل كل خير',
    ],
    openers: [
      'الله يبارك فيك يا أبو سليم،',
      'الحمد لله أولاً وآخراً،',
      'يا أخي الفاضل،',
      '',
      '',
    ],
    profitBodies: [
      (c) =>
        c.profitText
          ? `${c.profitText}${c.assetText ? ` في ${c.assetText}` : ''} رزق مبارك بالهدوء وعدم الطمع، نسأل الله البركة للجميع`
          : `خروج موفق وحصيلة طيبة${c.assetText ? ` على ${c.assetText}` : ''} تدل على حسن التدبير`,
      (c) =>
        c.profitText
          ? `البركة في القليل المنضبط، و${c.profitText} اليوم حصاد تعب وتركيز واضح`
          : `ما شاء الله، التدرج والثبات بدون استعجال هو اللي صنع الفرق اليوم`,
      () => `حفظك الله يا سليم، قراءة متزنة وتوجيه سديد يطمن الواحد وهو يتابع`,
    ],
    analysisBodies: [
      (c) => `توجيه سديد${c.assetText ? ` حول ${c.assetText}` : ''}، نسأل الله التوفيق والسداد`,
      () => `تحليل هادئ ومتوازن كعادتك، وبإذن الله تتضح الحركة قريباً`,
    ],
    lossBodies: [
      () => `الحمد لله على كل حال، الخسارة القليلة المحسوبة درس ووقاية من الخسارة الكبيرة`,
      () => `لا بأس يا أبو سليم، السوق أيام والرزق مكتوب، المهم السلامة والالتزام`,
    ],
    replyConnectors: [
      'بارك الله فيك على هذه الملاحظة،',
      'صدقت يا أخي،',
      'وهذا اللي لمسناه فعلاً،',
      'كلام موزون،',
    ],
    closings: [
      'الله يرزق الجميع من واسع فضله.',
      'بارك الله لكم في أوقاتكم.',
      'في حفظ الله.',
      '',
    ],
  },
  إبّي: {
    shortExclaims: [
      'روعة يا سليم، ما شاء الله تبارك الله',
      'أبدعت والله، صفقة في المليان',
      'يا عيني على التوقيت، تسلم يا قايد',
      'مبارك يا شباب، خطوة حلوة ومرتبة',
    ],
    openers: [
      'يا عيني عليك يا سليم،',
      'والله بصراحة،',
      'ما شاء الله يا قايد،',
      '',
      '',
    ],
    profitBodies: [
      (c) =>
        c.profitText
          ? `جبنا الـ ${c.profitText}${c.assetText ? ` من ${c.assetText}` : ''} بكل أريحية، هذا التداول اللي يرفع المعنويات`
          : `دخول ذكي وحصاد سريع للأهداف${c.assetText ? ` في ${c.assetText}` : ''}، عقبال القادم أقوى`,
      (c) =>
        c.assetText
          ? `تفاعل ${c.assetText} مشى بالضبط زي ما توقعت، والربح${c.profitText ? ` (${c.profitText})` : ''} جا في محله`
          : `أهم حاجة الالتزام بنقطة الخروج بدون تردد، وشغلك يا سليم يبرد القلب`,
    ],
    analysisBodies: [
      (c) => `متحمسين نشوف حركة ${c.assetText || 'السوق'} الجاية مع تحليلك الرايق`,
      () => `خطة مرتبة وسهلة الفهم للجميع، يعطيك ألف عافية`,
    ],
    lossBodies: [
      () => `المهم الالتزام، وصفقة وحدة ما تغيّر المسار العام للتحدي بإذن الله`,
      () => `ربنا يعوّضها بأحسن منها، التجربة والانضباط هم المكسب الحقيقي`,
    ],
    replyConnectors: [
      'أشهد بالله،',
      'فعلاً يا جماعة،',
      'كلامك سليم وأنا معك،',
      'بلا شك،',
    ],
    closings: [
      'الله يسعدكم جميعاً.',
      'بانتظار القادم يا قايد.',
      'بالتوفيق للكل.',
      '',
    ],
  },
  يافعي: {
    shortExclaims: [
      'كفو يا ذيب، قراءة ما تخرش الميه',
      'حيّاك الله يا سليم، شغل رجال ومرتب',
      'مبروك الربح، خطوة ثابتة للأمام',
      'الله يوفقك ويزيدك تألق يا قائد',
    ],
    openers: [
      'حيّا الله القائد،',
      'بصراحة يا سليم،',
      'والله شغلك يبيض الوجه،',
      '',
      '',
    ],
    profitBodies: [
      (c) =>
        c.profitText
          ? `${c.profitText}${c.assetText ? ` في ${c.assetText}` : ''} حلال زلال، وثمرة المتابعة الدقيقة والهدوء`
          : `نجاح واضح في قنص الحركة${c.assetText ? ` على ${c.assetText}` : ''} بدون أي تخبط`,
      (c) =>
        c.profitText
          ? `تحدي سليم يثبت يوم بعد يوم إنه ماشي بثبات، و${c.profitText} خطوة ممتازة`
          : `الدخول المحسوب يريح البال ويحقق الهدف بهدوء، تسلم يا غالي`,
    ],
    analysisBodies: [
      (c) => `متابعين معك في ${c.assetText || 'الصفقات'} أول بأول، قراءة تبعث على الثقة`,
      () => `نقاط واضحة وما فيها لبس، الله يوفقنا للخير`,
    ],
    lossBodies: [
      () => `البطل هو اللي يحفظ حسابه وقت الانعكاس، وما قصرت بالالتزام بالوقف`,
      () => `كل متداول يمر بوقف خسارة، والعبرة بالنتيجة النهائية في نهاية الأسبوع`,
    ],
    replyConnectors: [
      'كلامك ذهب،',
      'بالضبط زي ما تفضلت،',
      'ونعم بالله،',
      'هذا الكلام الصح،',
    ],
    closings: [
      'موفق دايماً يا أبو سليم.',
      'عقبال الأهداف الأكبر.',
      'دمتم بخير.',
      '',
    ],
  },
  'فصحى يمنية': {
    shortExclaims: [
      'أداء منضبط ومميز يا قائد سليم',
      'نتيجة موفقة، نسأل الله لكم دوام التوفيق',
      'قراءة دقيقة وإدارة حكيمة للصفقة',
      'مبارك عليكم هذا الإنجاز الطيب',
    ],
    openers: [
      'تقديرنا لجهودك يا قائد سليم،',
      'في الحقيقة،',
      'ما شاء الله،',
      '',
      '',
    ],
    profitBodies: [
      (c) =>
        c.profitText
          ? `تحقيق ${c.profitText}${c.assetText ? ` في ${c.assetText}` : ''} يعكس التزاماً حقيقياً بإدارة المخاطر والانتظار للتوقيت المناسب`
          : `الوصول للأهداف المرسومة${c.assetText ? ` على ${c.assetText}` : ''} يؤكد قوة التحليل وثبات الخطة`,
      (c) =>
        `الهدوء والانضباط عند تنفيذ الصفقة هما مفتاح الاستمرارية${c.profitText ? `، وربح ${c.profitText} ثمرة طيبة` : ''}`,
    ],
    analysisBodies: [
      (c) => `قراءة متزنة${c.assetText ? ` لحركة ${c.assetText}` : ''}، ونسأل الله التوفيق في القادم`,
      () => `شرح وافٍ يضع النقاط على الحروف، نتابع معك التحديثات`,
    ],
    lossBodies: [
      () => `الالتزام بوقف الخسارة جزء أصيل من النجاح، والعبرة بإجمالي الأداء على المدى القريب`,
      () => `نتعامل مع وقف الخسارة بهدوء، والفرص المتجددة في السوق تعوّض بإذن الله`,
    ],
    replyConnectors: [
      'أوافقك الرأي تماماً،',
      'إضافة قيّمة، وفعلاً',
      'صدقت، فالالتزام',
      'كما ذكرت تماماً،',
    ],
    closings: [
      'نسأل الله البركة والتوفيق للجميع.',
      'واصل هذا العطاء المميز.',
      '',
    ],
  },
};

function selectDiversePersonas(
  count: number,
  realNamesNormSet: Set<string>
): Array<{ name: string; dialect: string; gender: 'm' | 'f' }> {
  const shuffled = shuffleArr(YEMENI_PERSONA_POOL);
  const picked: Array<{ name: string; dialect: string; gender: 'm' | 'f' }> = [];
  const usedNorm = new Set<string>(realNamesNormSet);

  for (const cand of shuffled) {
    if (picked.length >= count) break;
    const n = normMatch(cand.name);
    if (!usedNorm.has(n)) {
      usedNorm.add(n);
      picked.push(cand);
    }
  }

  let idx = 0;
  while (picked.length < count) {
    const base = YEMENI_PERSONA_POOL[idx % YEMENI_PERSONA_POOL.length];
    const suf = FALLBACK_SURNAMES[(idx + 3) % FALLBACK_SURNAMES.length];
    let candidateName = `${base.name.split(' ')[0]} ${suf}`;
    if (usedNorm.has(normMatch(candidateName))) {
      candidateName = `${base.name.split(' ')[0]} ${suf} ${picked.length + 1}`;
    }
    usedNorm.add(normMatch(candidateName));
    picked.push({ name: candidateName, dialect: base.dialect, gender: base.gender });
    idx++;
  }

  return picked;
}

export function generateInternalYemeniPersonas(params: {
  topic: string;
  count: number;
  channelName: string;
  recentMessagesSample: string[];
  realNamesNormSet: Set<string>;
}): InternalPersonaDraftItem[] {
  const safeCount = Math.max(1, Math.min(30, Math.floor(Number(params.count) || 3)));
  const ctx = analyzeTopicAndChannelContext(params);
  const personas = selectDiversePersonas(safeCount, params.realNamesNormSet);

  const usedTexts = new Set<string>(params.recentMessagesSample.map((t) => normMatch(t)));
  const usedOpeners = new Set<string>();
  const usedBodies = new Set<string>();
  const usedClosings = new Set<string>();

  const styleModes = ['قصير وعفوي', 'متوسط متفاعل', 'رد حواري متصل', 'تحليلي هادئ', 'تشجيعي مختصر'];
  const items: InternalPersonaDraftItem[] = [];

  for (let i = 0; i < personas.length; i++) {
    const persona = personas[i];
    const bank = DIALECT_BANKS[persona.dialect] || DIALECT_BANKS['صنعاني'];

    // Distribute length & conversational connection naturally across items
    const useShort = i === 0 ? crypto.randomInt(0, 3) === 0 : i % 4 === 2;
    const useReplyConnector = safeCount >= 2 && i > 0 && (i === 1 || i % 3 === 1);
    let text = '';
    let styleTag = styleModes[i % styleModes.length];

    for (let attempt = 0; attempt < 24; attempt++) {
      let candidate = '';
      if (useShort && attempt < 8) {
        const ex = pickRandom(bank.shortExclaims);
        if (!usedBodies.has(normMatch(ex))) {
          candidate = ex;
          styleTag = 'قصير وعفوي';
        }
      }

      if (!candidate) {
        const bodyPool = ctx.isLoss
          ? bank.lossBodies
          : ctx.isAnalysis
          ? bank.analysisBodies
          : bank.profitBodies;
        const rawBodyFn = bodyPool[(i + attempt) % bodyPool.length];
        const body = rawBodyFn(ctx);
        const normBody = normMatch(body);
        if (usedBodies.has(normBody) && attempt < 16) continue;

        let prefix = '';
        if (useReplyConnector && attempt < 16) {
          const connCandidates = bank.replyConnectors.filter((c) => !usedOpeners.has(normMatch(c)));
          prefix = connCandidates.length > 0 ? pickRandom(connCandidates) : pickRandom(bank.replyConnectors);
          styleTag = 'رد حواري متصل';
        } else {
          const openCandidates = bank.openers.filter((o) => !o || !usedOpeners.has(normMatch(o)));
          prefix = openCandidates.length > 0 ? pickRandom(openCandidates) : '';
        }

        const closingCandidates = bank.closings.filter((cl) => !cl || !usedClosings.has(normMatch(cl)));
        const closing =
          i % 2 === 0 && closingCandidates.length > 0 ? pickRandom(closingCandidates) : '';

        candidate = [prefix, body, closing].filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();
      }

      const normCand = normMatch(candidate);
      if (candidate && !usedTexts.has(normCand)) {
        text = candidate;
        usedTexts.add(normCand);
        usedBodies.add(normMatch(candidate.split(/[،.]/)[0] || candidate));
        if (useReplyConnector) {
          const firstSeg = candidate.split('،')[0];
          if (firstSeg) usedOpeners.add(normMatch(firstSeg));
        }
        break;
      }
    }

    if (!text) {
      const fallbackBody = (ctx.isLoss
        ? bank.lossBodies[0]
        : ctx.isAnalysis
        ? bank.analysisBodies[0]
        : bank.profitBodies[0])(ctx);
      text = `${fallbackBody}${ctx.topicSnippet && i % 2 === 1 ? ` (${ctx.topicSnippet})` : ''}`.trim();
      usedTexts.add(normMatch(text));
    }

    items.push({
      id: `vp_${i + 1}_${crypto.randomBytes(3).toString('hex')}`,
      personaName: persona.name,
      dialect: persona.dialect,
      styleTag,
      text,
    });
  }

  return items;
}
