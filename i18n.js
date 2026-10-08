const TRANSLATIONS = {
  en: {
    context: 'this session context',
    fiveHour: '5-hour limit',
    weekly: 'weekly limit',
    used: 'used',
    remaining: 'remaining',
    resets: 'resets',
    launchTitle: 'How should Claude Code start?',
    launchNormal: 'Normal',
    launchSkipPerm: 'Skip permission prompts',
    model: 'Model',
    modelDefault: 'Default (Claude Code)',
  },
  de: {
    context: 'Kontext dieser Sitzung',
    fiveHour: '5-Stunden-Limit',
    weekly: 'Wochenlimit',
    used: 'genutzt',
    remaining: 'übrig',
    resets: 'Reset',
    launchTitle: 'Wie soll Claude Code starten?',
    launchNormal: 'Normal',
    launchSkipPerm: 'Berechtigungsabfragen überspringen',
    model: 'Modell',
    modelDefault: 'Standard (Claude Code)',
  },
  tr: {
    context: "bu oturum context'i",
    fiveHour: '5 saatlik limit',
    weekly: 'haftalık limit',
    used: 'kullanıldı',
    remaining: 'kaldı',
    resets: 'sıfırlanma',
    launchTitle: 'Claude Code nasıl başlasın?',
    launchNormal: 'Normal',
    launchSkipPerm: 'Yetki onayı sorma',
    model: 'Model',
    modelDefault: 'Varsayılan (Claude Code)',
  },
  es: {
    context: 'contexto de esta sesión',
    fiveHour: 'límite de 5 horas',
    weekly: 'límite semanal',
    used: 'usado',
    remaining: 'restante',
    resets: 'se reinicia',
    launchTitle: '¿Cómo debe iniciarse Claude Code?',
    launchNormal: 'Normal',
    launchSkipPerm: 'Omitir confirmaciones de permisos',
    model: 'Modelo',
    modelDefault: 'Predeterminado (Claude Code)',
  },
};

const SUPPORTED_LANGS = Object.keys(TRANSLATIONS);

function detectLang() {
  try {
    const saved = localStorage.getItem('claudeterm-lang');
    if (saved && SUPPORTED_LANGS.includes(saved)) return saved;
  } catch {}
  const sys = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return SUPPORTED_LANGS.includes(sys) ? sys : 'en';
}

function setLang(lang) {
  try {
    localStorage.setItem('claudeterm-lang', lang);
  } catch {}
}

function t(lang, key) {
  return (TRANSLATIONS[lang] || TRANSLATIONS.en)[key] || key;
}
