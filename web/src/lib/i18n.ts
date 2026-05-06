// web/src/lib/i18n.ts
//
// i18next setup with EN + HI bundles for the auth flows + core nav. Scope
// is intentionally narrow: every translation here serves a high-traffic
// user-facing surface (login, password reset, first-login wizard, sidebar
// nav, idle warning, session page). Other modules still use hard-coded
// English copy until they stabilize — translating throwaway prototype
// strings is churn.
//
// Persistence: the user's choice is stored in localStorage under the
// `apex.ews.lang` key (separate from the auth blob so logging out doesn't
// reset the language).

import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

export const SUPPORTED_LANGS = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी' },
] as const;

export type LangCode = (typeof SUPPORTED_LANGS)[number]['code'];

const en = {
  common: {
    sign_in: 'Sign in',
    sign_out: 'Sign out',
    username: 'Username',
    password: 'Password',
    email: 'Email',
    refresh: 'Refresh',
    save: 'Save',
    cancel: 'Cancel',
    continue: 'Continue',
    download: 'Download',
    loading: 'Loading…',
    language: 'Language',
  },
  nav: {
    dashboard: 'Dashboard',
    alerts: 'Alerts',
    customers: 'Customers',
    rules: 'Rules',
    ews_rules: 'EWS Rule Builder',
    cases: 'Cases (legacy)',
    cms_cases: 'Case Management',
    scenario: 'Scenario',
    reports: 'Reports',
    my_sessions: 'My sessions',
    my_activity: 'My activity',
    users: 'Users',
    integrations: 'Integrations',
    audit_log: 'Audit log',
    webhooks: 'Webhooks',
    tenants: 'Tenants',
    service_clients: 'Service clients',
    risk_operations: 'Risk Operations',
    tenant: 'Tenant',
  },
  login: {
    heading: 'Sign in',
    subtitle: 'Risk operations for authorised staff only',
    forgot_password: 'Forgot password?',
    new_to_apex: 'New to APEX EWS?',
    create_account: 'Create an account',
    invalid_credentials: 'Invalid credentials. Please try again.',
    locked_account: 'Account is locked. Contact your administrator.',
    generic_error: 'Sign-in failed. Please try again.',
    network_unreachable:
      'Cannot reach the server. Check that the dev server is running and reload the page (Cmd/Ctrl+Shift+R).',
    rate_limited: 'Too many sign-in attempts. Please wait a minute and try again.',
    idle_signed_out:
      'You were signed out after a period of inactivity. Please sign in again.',
    demo_accounts_label: 'Demo accounts',
    demo_passwords_in_seed: 'passwords in auth-svc seed',
    captcha_required: 'Too many failed attempts — please solve the CAPTCHA below.',
    captcha_failed: 'CAPTCHA answer was wrong or expired. Try the new one below.',
    captcha_answer_label: 'Your answer',
    captcha_refresh: 'Refresh CAPTCHA',
  },
  forgot: {
    heading: 'Reset your password',
    subtitle:
      "Enter your APEX EWS username or email address — we'll generate a single-use reset link valid for 15 minutes.",
    identifier_label: 'Username or email',
    send_link: 'Send reset link',
    back_to_signin: '← Back to sign in',
    remember_it: 'Remembered it?',
    inbox_heading: 'Check your inbox',
    prototype_link_label: 'Prototype reset link (no SMTP in dev)',
    copy_link: 'Copy reset link',
    expires_default: 'in 15 minutes',
    failure: 'Reset request failed. Try again.',
  },
  reset: {
    heading: 'Choose a new password',
    subtitle: 'The link is single-use and expires 15 minutes after it was issued.',
    new_password: 'New password',
    confirm_new_password: 'Confirm new password',
    submit: 'Reset password',
    success_heading: 'Password updated',
    continue_to_signin: 'Continue to sign in',
    expired:
      'This reset link is invalid or has expired. Request a new one from the forgot-password page.',
    generic_error: 'Reset failed. Please try again.',
    need_new_link: 'Need a new link?',
    request_another: 'Request another',
  },
  first_login: {
    welcome: 'Welcome,',
    heading: 'Set up your account',
    subtitle:
      "Choose a new password and accept the prototype terms before you continue. You won't see this screen again.",
    accept_terms:
      'I understand this is a prototype environment with synthetic data. I will treat all dashboards, alerts, and exports as confidential.',
    must_accept_terms: 'You must accept the prototype terms to continue.',
    submit: 'Set password and continue',
    generic_error: "Couldn't complete first sign-in. Please try again.",
    password_reused: 'This password has been used before — choose a different one.',
  },
  idle: {
    title: "You'll be signed out soon",
    body: 'For security, your session ends after {{minutes}} minutes of inactivity.',
    countdown_prefix: 'Signing out in',
    countdown_suffix: 'seconds.',
    sign_out_now: 'Sign out now',
    stay_signed_in: 'Stay signed in',
  },
  sessions: {
    heading: 'Active sessions',
    subtitle:
      "Devices currently signed in to your APEX EWS account · revoke any you don't recognise",
    your_sessions: 'Your sessions',
    sign_out_other: 'Sign out other devices',
    this_device: 'This device',
    sign_out_one: 'Sign out',
    none_to_revoke: 'No other sessions to sign out.',
    signed_out_n: 'Signed out {{count}} other session.',
    signed_out_n_plural: 'Signed out {{count}} other sessions.',
    no_sessions: 'No active sessions found.',
    load_failure: 'Could not load sessions. Try refreshing.',
    last_active: 'last active',
    signed_in: 'signed in',
    just_now: 'just now',
    explainer:
      "Each sign-in creates a session that's tracked server-side. Revoking a session invalidates its refresh token immediately — that device will need to sign in again. Existing access tokens remain valid until their natural 15-minute expiry, after which the next request will fail.",
  },
};

// Hindi translations — covers the same surface area as the English bundle.
// Kept in one block so adding a new key to en immediately surfaces a
// missing-key warning in i18next dev mode.
const hi: typeof en = {
  common: {
    sign_in: 'साइन इन करें',
    sign_out: 'साइन आउट',
    username: 'उपयोगकर्ता नाम',
    password: 'पासवर्ड',
    email: 'ईमेल',
    refresh: 'रीफ़्रेश',
    save: 'सहेजें',
    cancel: 'रद्द करें',
    continue: 'जारी रखें',
    download: 'डाउनलोड',
    loading: 'लोड हो रहा है…',
    language: 'भाषा',
  },
  nav: {
    dashboard: 'डैशबोर्ड',
    alerts: 'अलर्ट',
    customers: 'ग्राहक',
    rules: 'नियम',
    ews_rules: 'EWS नियम निर्माता',
    cases: 'केस (पुराना)',
    cms_cases: 'केस प्रबंधन',
    scenario: 'परिदृश्य',
    reports: 'रिपोर्ट',
    my_sessions: 'मेरे सत्र',
    my_activity: 'मेरी गतिविधि',
    users: 'उपयोगकर्ता',
    integrations: 'एकीकरण',
    audit_log: 'ऑडिट लॉग',
    webhooks: 'वेबहुक',
    tenants: 'किरायेदार',
    service_clients: 'सेवा क्लाइंट',
    risk_operations: 'जोखिम संचालन',
    tenant: 'किरायेदार',
  },
  login: {
    heading: 'साइन इन करें',
    subtitle: 'केवल अधिकृत कर्मचारियों के लिए जोखिम संचालन',
    forgot_password: 'पासवर्ड भूल गए?',
    new_to_apex: 'APEX EWS पर नए?',
    create_account: 'खाता बनाएं',
    invalid_credentials: 'अमान्य क्रेडेंशियल। कृपया पुनः प्रयास करें।',
    locked_account: 'खाता लॉक है। अपने प्रशासक से संपर्क करें।',
    generic_error: 'साइन-इन विफल। कृपया पुनः प्रयास करें।',
    network_unreachable:
      'सर्वर तक नहीं पहुंच सकते। सुनिश्चित करें कि dev सर्वर चल रहा है और पेज रीलोड करें (Cmd/Ctrl+Shift+R)।',
    rate_limited: 'बहुत अधिक साइन-इन प्रयास। कृपया एक मिनट प्रतीक्षा करें और पुनः प्रयास करें।',
    idle_signed_out:
      'निष्क्रियता की अवधि के बाद आपको साइन आउट कर दिया गया था। कृपया फिर से साइन इन करें।',
    demo_accounts_label: 'डेमो खाते',
    demo_passwords_in_seed: 'पासवर्ड auth-svc सीड में हैं',
    captcha_required: 'कई असफल प्रयास हुए — कृपया नीचे CAPTCHA हल करें।',
    captcha_failed: 'CAPTCHA उत्तर गलत था या समाप्त हो गया। नीचे दिया गया नया प्रयास करें।',
    captcha_answer_label: 'आपका उत्तर',
    captcha_refresh: 'CAPTCHA रीफ़्रेश करें',
  },
  forgot: {
    heading: 'अपना पासवर्ड रीसेट करें',
    subtitle:
      'अपना APEX EWS उपयोगकर्ता नाम या ईमेल पता दर्ज करें — हम 15 मिनट के लिए वैध एकल-उपयोग रीसेट लिंक बनाएंगे।',
    identifier_label: 'उपयोगकर्ता नाम या ईमेल',
    send_link: 'रीसेट लिंक भेजें',
    back_to_signin: '← साइन इन पर वापस',
    remember_it: 'याद आ गया?',
    inbox_heading: 'अपना इनबॉक्स देखें',
    prototype_link_label: 'प्रोटोटाइप रीसेट लिंक (डेव में SMTP नहीं)',
    copy_link: 'रीसेट लिंक कॉपी करें',
    expires_default: '15 मिनट में',
    failure: 'रीसेट अनुरोध विफल। पुनः प्रयास करें।',
  },
  reset: {
    heading: 'नया पासवर्ड चुनें',
    subtitle: 'लिंक एकल-उपयोग है और जारी होने के 15 मिनट बाद समाप्त हो जाता है।',
    new_password: 'नया पासवर्ड',
    confirm_new_password: 'नए पासवर्ड की पुष्टि करें',
    submit: 'पासवर्ड रीसेट करें',
    success_heading: 'पासवर्ड अपडेट हुआ',
    continue_to_signin: 'साइन इन पर जारी रखें',
    expired:
      'यह रीसेट लिंक अमान्य है या समाप्त हो गया है। पासवर्ड भूल गए पृष्ठ से नया अनुरोध करें।',
    generic_error: 'रीसेट विफल। कृपया पुनः प्रयास करें।',
    need_new_link: 'नए लिंक की आवश्यकता है?',
    request_another: 'दूसरा अनुरोध करें',
  },
  first_login: {
    welcome: 'स्वागत है,',
    heading: 'अपना खाता सेट करें',
    subtitle:
      'जारी रखने से पहले एक नया पासवर्ड चुनें और प्रोटोटाइप शर्तों को स्वीकार करें। आप यह स्क्रीन फिर से नहीं देखेंगे।',
    accept_terms:
      'मैं समझता हूं कि यह सिंथेटिक डेटा वाला प्रोटोटाइप वातावरण है। मैं सभी डैशबोर्ड, अलर्ट और निर्यात को गोपनीय मानूंगा।',
    must_accept_terms: 'जारी रखने के लिए आपको प्रोटोटाइप शर्तें स्वीकार करनी होंगी।',
    submit: 'पासवर्ड सेट करें और जारी रखें',
    generic_error: 'पहली बार साइन-इन पूरा नहीं हो सका। कृपया पुनः प्रयास करें।',
    password_reused: 'यह पासवर्ड पहले उपयोग किया जा चुका है — कोई अलग चुनें।',
  },
  idle: {
    title: 'आपको जल्द ही साइन आउट कर दिया जाएगा',
    body: 'सुरक्षा के लिए, {{minutes}} मिनट की निष्क्रियता के बाद आपका सत्र समाप्त हो जाता है।',
    countdown_prefix: 'साइन आउट हो रहा है',
    countdown_suffix: 'सेकंड में।',
    sign_out_now: 'अभी साइन आउट करें',
    stay_signed_in: 'साइन इन रहें',
  },
  sessions: {
    heading: 'सक्रिय सत्र',
    subtitle:
      'वर्तमान में आपके APEX EWS खाते में साइन इन डिवाइस · किसी भी अनजाने को रद्द करें',
    your_sessions: 'आपके सत्र',
    sign_out_other: 'अन्य डिवाइस से साइन आउट करें',
    this_device: 'यह डिवाइस',
    sign_out_one: 'साइन आउट',
    none_to_revoke: 'साइन आउट करने के लिए कोई अन्य सत्र नहीं।',
    signed_out_n: '{{count}} अन्य सत्र से साइन आउट किया गया।',
    signed_out_n_plural: '{{count}} अन्य सत्रों से साइन आउट किया गया।',
    no_sessions: 'कोई सक्रिय सत्र नहीं मिला।',
    load_failure: 'सत्र लोड नहीं हो सके। रीफ़्रेश करने का प्रयास करें।',
    last_active: 'अंतिम सक्रिय',
    signed_in: 'साइन इन किया',
    just_now: 'अभी',
    explainer:
      'प्रत्येक साइन-इन एक सत्र बनाता है जो सर्वर-साइड पर ट्रैक किया जाता है। एक सत्र को रद्द करने से उसका रीफ़्रेश टोकन तुरंत अमान्य हो जाता है — उस डिवाइस को फिर से साइन इन करना होगा। मौजूदा एक्सेस टोकन उनकी प्राकृतिक 15-मिनट समाप्ति तक मान्य रहते हैं, जिसके बाद अगला अनुरोध विफल हो जाएगा।',
  },
};

const STORAGE_KEY = 'apex.ews.lang';

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en }, hi: { translation: hi } },
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGS.map((l) => l.code),
    interpolation: { escapeValue: false }, // React already escapes
    detection: {
      // Order: explicit choice first (localStorage), then browser hint.
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: STORAGE_KEY,
      caches: ['localStorage'],
    },
    // Prototype-friendly defaults — turn on missing-key warnings only in
    // dev so production logs aren't noisy. Vite injects import.meta.env.DEV.
    debug: false,
    saveMissing: import.meta.env.DEV,
    returnNull: false,
  });

export { i18n };
