// app.js — منطق الواجهة الأمامية (الزبون) — ثنائي اللغة + حساب + بطاقة العضوية
import { db, auth } from "./firebase.js";
import { getLang, setLang, t } from "./i18n.js";
import {
  collection,
  onSnapshot,
  addDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence,
  signOut,
  EmailAuthProvider,
  reauthenticateWithCredential,
  deleteUser,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

const authReady = setPersistence(auth, browserLocalPersistence).catch(() => {});

const PLANS_META = [
  { id: "daily", days: 1, discount: 0 },
  { id: "weekly", days: 7, discount: 0.1 },
  { id: "monthly", days: 30, discount: 0.2 },
];
const CAT_IDS = ["all", "breakfast", "lunch", "dinner"];
const CAT_EMOJI = { all: "🍽", breakfast: "☀", lunch: "🍲", dinner: "🌙" };
// طرق الأداء المتاحة للزبون فصفحة إتمام الطلب — الأدمين كيقدر يفعّل/يعطّل كل وحدة ويحط ليها RIB من لوحة التحكم (config/paymentMethods)
const PAYMENT_METHODS = [
  { id: "card", icon: "💳" },
  { id: "cod", icon: "💵" },
  { id: "tpe", icon: "📟" },
  { id: "cih", icon: "🏦", img: "img/payments/cih.png" },
  { id: "fellah", icon: "🌾", img: "img/payments/fellah.jpg" },
  { id: "cashplus", icon: "💸", img: "img/payments/cashplus.jpg" },
  { id: "wafacash", icon: "💰", img: "img/payments/wafacash.jpg" },
  { id: "tijari", icon: "🏛", img: "img/payments/tijari.jpg" },
  { id: "baridbank", icon: "📮", img: "img/payments/baridbank.jpg" },
];
// كيرجع HTML ديال أيقونة طريقة الأداء: تصويرة الشركة إلا كانت، وإلا الإيموجي كـ fallback
function paymentIconHtml(pm) {
  return pm.img
    ? `<img src="${pm.img}" alt="${pm.id}" class="pay-icon-img" onerror="this.outerHTML='${pm.icon}'">`
    : pm.icon;
}
// الحد الأدنى لعدد أيام الطلب باش يستحق الزبون بطاقة العضوية تلقائياً
const MEMBERSHIP_MIN_DAYS = 3;
const PHONE_RE = /^(0[5-7]\d{8}|\+212[5-7]\d{8})$/;

// قواعد احتساب النقاط الافتراضية — الأدمين يقدر يبدلها من config/pointsRules،
// وإلا ما كايناش وثيقة، هاد القيم هي لي كتخدم
const DEFAULT_POINTS_RULES = {
  firstOrderPoints: 50,
  perDirham: 10, // كل 10 دراهم = نقطة وحدة
  reviewPoints: 10,
  referralPoints: 150,
  streak3Bonus: 50,
  monthly5Bonus: 100,
  monthly10Bonus: 200,
};
const TIERS = [
  { id: "bronze", min: 0, max: 499 },
  { id: "silver", min: 500, max: 999 },
  { id: "gold", min: 1000, max: 1999 },
  { id: "vip", min: 2000, max: Infinity },
];
let pointsRules = { ...DEFAULT_POINTS_RULES };

let lang = getLang();
let meals = [];
let dailyMealImage = "";
let cart = {};
let category = "all",
  plan = "weekly";
// طرق الأداء: الإعدادات (RIB/تفعيل) جاية من config/paymentMethods، والطريقة المختارة فالطلب الحالي
let paymentMethodsConfig = {};
let paymentMethod = null;
let paymentPickerOpen = false;

/* ---------- الحساب / تسجيل الدخول ---------- */
let currentUser = null; // كائن Firebase Auth
let userProfile = null; // { phone, gender, avatar }
let membershipData = null; // { name, phone, avatar, startDate, endDate, ... } أو null
let authTab = "login";
let signupGender = "male";
let countdownInterval = null;
let pendingCheckoutAfterLogin = false;
let pendingSupportAfterLogin = false;
let profileIncomplete = false; // true إلا دخل الزبون بـ Google/Apple ومازال ما كملش رقم الهاتف/الجنس
let chatUnsubscribe = null;
let unreadUnsubscribe = null;
let hasUnreadSupport = false; // حالة وجود رسائل دعم غير مقروءة — كتحدث نقطة التنبيه فالقائمة وزر ☰

const googleProvider = new GoogleAuthProvider();
const appleProvider = new OAuthProvider("apple.com");

function phoneToEmail(phone) {
  return `${phone}@wajbati.app`;
}
function normalizePhone(raw) {
  // كيحول أي صيغة (+212612345678 / 212612345678 / 0612345678) لنفس الصيغة الموحدة
  // باش نفس رقم الهاتف يعطي دائماً نفس "الإيميل المصطنع"، فتسجيل الدخول يخدم بجد
  let p = String(raw || "").replace(/[\s-]/g, "").trim();
  if (p.startsWith("+212")) p = "0" + p.slice(4);
  else if (p.startsWith("212") && p.length === 12) p = "0" + p.slice(3);
  return p;
}
function avatarFor(gender) {
  return gender === "female" ? "👩" : "👨";
}

function money(n) {
  const cur = lang === "fr" ? "DH" : "درهم";
  const locale = lang === "fr" ? "fr-FR" : "ar-MA";
  return `${Math.round(n).toLocaleString(locale)} ${cur}`;
}
function formatDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  const locale = lang === "fr" ? "fr-FR" : "ar-MA";
  return date.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
}
function filtered() {
  return category === "all" ? meals : meals.filter((m) => m.category === category);
}
function cartItems() {
  return Object.entries(cart)
    .map(([id, qty]) => {
      const m = meals.find((x) => x.id === id);
      return m ? { ...m, qty } : null;
    })
    .filter(Boolean);
}
function dailyTotal() {
  return cartItems().reduce((s, m) => s + m.price * m.qty, 0);
}
function total() {
  // تقدير أولي (قبل ما يختار الزبون التواريخ الحقيقية فنافذة الطلب) — مبني على مدة الباقة النموذجية فقط
  const p = PLANS_META.find((x) => x.id === plan);
  return dailyTotal() * p.days * (1 - p.discount);
}
function actualDays() {
  const from = document.getElementById("dateFrom")?.value;
  const to = document.getElementById("dateTo")?.value;
  if (!from || !to) return null;
  const f = new Date(from + "T00:00:00");
  const tt = new Date(to + "T00:00:00");
  const d = Math.round((tt - f) / 86400000) + 1;
  return d > 0 ? d : null;
}
function checkoutTotal() {
  // السعر الحقيقي: مبني على عدد الأيام الفعلي المختار (من - إلى)، ماشي على مدة الباقة الثابتة
  const p = PLANS_META.find((x) => x.id === plan);
  const days = actualDays() ?? p.days;
  return dailyTotal() * days * (1 - p.discount);
}
function count() {
  return Object.values(cart).reduce((a, b) => a + b, 0);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}
function escapeAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
// كينسخ نص لحافظة الجهاز (RIB أو اسم صاحب الحساب) وكيبين ✓ فالزر لمدة قصيرة كتأكيد للزبون
function copyToClipboard(btn) {
  const text = btn.dataset.copy || "";
  const done = () => {
    const original = btn.textContent;
    btn.textContent = "✓";
    setTimeout(() => {
      btn.textContent = original;
    }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, cb) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch (e) {
    /* تجاهل */
  }
  document.body.removeChild(ta);
  if (cb) cb();
}

/* ---------- بانر وجبة اليوم (فوق الفئات: الكل/الفطور/الغداء/العشاء) ---------- */
function renderDailyMealBanner() {
  const banner = document.getElementById("dailyMealBanner");
  const img = document.getElementById("dailyMealImg");
  if (!banner || !img) return;
  if (dailyMealImage) {
    img.src = dailyMealImage;
    banner.classList.add("show");
  } else {
    banner.classList.remove("show");
  }
}

/* ---------- نصوص ثابتة (رأس الصفحة، الفوتر...) ---------- */
function applyStaticText() {
  const s = t(lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = s.dir;
  document.getElementById("badgeText").textContent = s.badge;
  document.getElementById("dailyMealBadge").textContent = s.dailyMealBadge;
  document.getElementById("tagline").textContent = s.tagline;
  document.getElementById("trust1b").textContent = s.trust1[0];
  document.getElementById("trust1s").textContent = s.trust1[1];
  document.getElementById("trust2b").textContent = s.trust2[0];
  document.getElementById("trust2s").textContent = s.trust2[1];
  document.getElementById("trust3b").textContent = s.trust3[0];
  document.getElementById("trust3s").textContent = s.trust3[1];
  document.getElementById("mobileTotalLabel").textContent = s.mobileTotalLabel;
  document.getElementById("mobileCheckoutBtn").textContent = s.mobileCheckoutBtn;
  document.getElementById("footerText").textContent = s.footer;
  document.querySelectorAll(".lang-btn").forEach((b) => b.classList.toggle("active", b.dataset.lang === lang));
  updateAccountButton();
}

/* ---------- القائمة الجانبية (☰) بدل أزرار رأس الصفحة ---------- */
// يفصل الإيموجي الأول عن النص (النصوص فالترجمة كلها بصيغة "إيموجي نص")
function splitIcon(str) {
  const idx = (str || "").indexOf(" ");
  if (idx === -1) return { icon: "", text: str || "" };
  return { icon: str.slice(0, idx), text: str.slice(idx + 1) };
}

function openSidebar() {
  renderSidebar();
  document.getElementById("sidebar").classList.add("show");
  document.getElementById("sidebarOverlay").classList.add("show");
}
function closeSidebar() {
  document.getElementById("sidebar").classList.remove("show");
  document.getElementById("sidebarOverlay").classList.remove("show");
}
// يسكر القائمة قبل ما يشغل الإجراء المطلوب (فتح الدعم، المكافآت...)
function openSidebarAction(fnName) {
  closeSidebar();
  window[fnName]();
}

function renderSidebar() {
  const s = t(lang);
  const body = document.getElementById("sidebarBody");
  if (!body) return;
  const items = [];

  const support = splitIcon(s.supportBtn);
  items.push(`<button class="side-item" onclick="openSidebarAction('openSupport')">
    <span class="side-icon">${support.icon}<span class="side-badge" id="sideSupportBadge"></span></span>
    <span class="side-label">${support.text}</span>
  </button>`);

  if (currentUser) {
    const rewards = splitIcon(s.rewardsBtn);
    items.push(`<button class="side-item" onclick="openSidebarAction('openRewards')">
      <span class="side-icon">${rewards.icon}</span>
      <span class="side-label">${rewards.text}</span>
    </button>`);
  }

  if (currentUser && membershipData) {
    const memText = lang === "fr" ? "Carte de membre" : "بطاقة العضوية";
    items.push(`<button class="side-item" onclick="openSidebarAction('openMembership')">
      <span class="side-icon">🎫</span>
      <span class="side-label">${memText}</span>
    </button>`);
  }

  const account =
    currentUser && userProfile
      ? { icon: userProfile.avatar || "👤", text: userProfile.phone || "" }
      : splitIcon(s.accountBtnLogin);
  items.push(`<button class="side-item" onclick="openSidebarAction('openAccount')">
    <span class="side-icon">${account.icon}</span>
    <span class="side-label">${account.text}</span>
  </button>`);

  body.innerHTML = items.join("");
  syncSupportBadgeUI();
}
// نبقيو الاسم القديم شغال (كيتصاوب عليه نداء فبزاف ديال الأماكن) وكيدير تحديث القائمة الجانبية
function updateAccountButton() {
  renderSidebar();
}
function switchLang(l) {
  if (l === lang) return;
  lang = l;
  setLang(l);
  applyStaticText();
  updateAccountButton();
  render();
}

/* ---------- عرض القائمة والسلة ---------- */
function renderCategories() {
  const s = t(lang);
  document.getElementById("categories").innerHTML = CAT_IDS.map(
    (id) => `<button class="cat ${category === id ? "active" : ""}" onclick="setCategory('${id}')">
      <span class="cat-circle">${CAT_EMOJI[id]}</span>
      <span class="cat-label">${s.categories[id]}</span>
    </button>`
  ).join("");
}
function setCategory(c) {
  category = c;
  render();
}
function add(id) {
  cart[id] = (cart[id] || 0) + 1;
  render();
}
function remove(id) {
  if (cart[id] > 1) cart[id]--;
  else delete cart[id];
  render();
}
function removeAll(id) {
  delete cart[id];
  render();
}

function renderMeals() {
  const s = t(lang);
  const list = filtered();
  const el = document.getElementById("meals");
  if (!meals.length) {
    el.innerHTML = `<div class="empty" style="grid-column:1/-1">${s.emptyNoMeals}</div>`;
    return;
  }
  el.innerHTML = list.length
    ? list
        .map(
          (m) => `
 <article class="meal">
  <div class="meal-img">
   <img src="${m.image || ""}" alt="${escapeHtml(m.name)}" loading="lazy" onerror="this.style.display='none'">
   <span class="category">${s.categories[m.category] || ""}</span>
  </div>
  <div class="meal-body">
   <h3>${escapeHtml(m.name)}</h3>
   <div class="desc">${escapeHtml(m.description || "")}</div>
   <div class="meal-bottom">
    <span class="price">${money(m.price)}</span>
    ${
      cart[m.id]
        ? `<div class="qty"><button onclick="remove('${m.id}')">−</button><b>${cart[m.id]}</b><button class="plus" onclick="add('${m.id}')">+</button></div>`
        : `<button class="add" onclick="add('${m.id}')">${s.addBtn}</button>`
    }
   </div>
  </div>
 </article>`
        )
        .join("")
    : `<div class="empty" style="grid-column:1/-1">${s.emptyCategory}</div>`;
}

function renderCart() {
  const s = t(lang);
  const items = cartItems();
  const el = document.getElementById("cartPanel");
  const mobile = document.getElementById("mobileCart");
  if (!items.length) {
    el.innerHTML = "";
    mobile.style.display = "none";
    return;
  }
  if (window.innerWidth <= 768) mobile.style.display = "flex";
  document.getElementById("mobileTotal").textContent = money(total());
  const p = PLANS_META.find((x) => x.id === plan);
  el.innerHTML = `<section class="panel">
  <h2 style="margin-top:0;color:#064e3b;font-size:20px;font-weight:900">${s.choosePlan}</h2>
  <div class="plans">${PLANS_META.map((x) => {
    const [label, note] = s.plans[x.id];
    return `<div class="plan ${plan === x.id ? "active" : ""}" onclick="choosePlan('${x.id}')"><strong>${label}${
      x.discount ? `<span class="discount">${note}</span>` : ""
    }</strong><small style="color:#78716c">${x.days} ${x.days === 1 ? s.day : s.days}</small></div>`;
  }).join("")}</div>
  <h3 style="margin-bottom:8px;font-size:16px">${s.cartTitle} <small style="color:#a8a29e;font-weight:normal">(${count()} ${s.itemsSuffix})</small></h3>
  ${items
    .map(
      (i) =>
        `<div class="cart-row"><div><b>${escapeHtml(i.name)}</b><br><small style="color:#78716c">${money(
          i.price
        )} ${s.perDish}</small></div><div class="qty"><button onclick="remove('${i.id}')">−</button><b>${i.qty}</b><button class="plus" onclick="add('${i.id}')">+</button><button onclick="removeAll('${i.id}')" style="border:0;background:none;color:#dc2626;margin:0 4px">🗑</button></div></div>`
    )
    .join("")}
  <div class="summary">
   <div class="sumrow"><span>${s.dailyCost}</span><b>${money(dailyTotal())}</b></div>
   <div class="sumrow"><span>${s.planDuration}</span><b>× ${p.days}</b></div>
   ${p.discount ? `<div class="sumrow" style="color:#047857"><span>${s.planDiscount}</span><b>-${p.discount * 100}%</b></div>` : ""}
   <div class="sumrow total"><span>${s.finalTotal}</span><b>${money(total())}</b></div>
  </div>
  <div class="field-note" style="text-align:center;margin-top:8px">${s.estimatedNote}</div>
  <button class="checkout" onclick="openCheckout()">${s.continueCheckout}</button>
 </section>`;
}
function choosePlan(p) {
  plan = p;
  render();
}
function render() {
  renderCategories();
  renderMeals();
  renderCart();
}

/* ---------- إتمام الطلب ---------- */
function openCheckout() {
  const s = t(lang);
  if (!cartItems().length) return;
  if (!currentUser) {
    pendingCheckoutAfterLogin = true;
    authTab = "login";
    document.getElementById("accountModal").classList.add("show");
    renderAccountAuth();
    return;
  }
  document.getElementById("checkoutModal").classList.add("show");
  paymentMethod = null;
  paymentPickerOpen = false;
  document.getElementById("checkoutContent").innerHTML = `
 <div class="modal-head"><h3>${s.checkoutTitle}</h3><button class="close" onclick="closeCheckout()">×</button></div>
 <div class="notice">${s.checkoutNotice}</div>
 <form onsubmit="submitOrder(event)">
  <label>${s.fullName}</label><input id="name" required placeholder="${s.fullNamePh}">
  <label>${s.phone}</label><input id="phone" required type="tel" inputmode="tel" placeholder="${s.phonePh}">
  <label>${s.address}</label>
  <div style="display:flex;gap:8px;align-items:center">
    <input id="address" required placeholder="${s.addressPh}" style="flex:1" oninput="document.getElementById('mapLink').value=''">
    <button type="button" id="locBtn" class="location-btn" onclick="useMyLocation()">${s.locateBtn}</button>
  </div>
  <input type="hidden" id="mapLink" value="">
  <div id="locStatus" class="field-note"></div>

  <div class="schedule-box">
    <div class="schedule-title">${s.scheduleTitle}</div>
    <div class="date-grid">
      <div><label>${s.fromDate}</label><input id="dateFrom" type="date" required onchange="onDateFromChange()"></div>
      <div><label>${s.toDate}</label><input id="dateTo" type="date" required onchange="updateSchedulePreview()"></div>
    </div>
    <div class="time-row">
      <div><label>${s.deliveryTime}</label><input id="deliveryTime" type="time" required onchange="updateSchedulePreview()"></div>
    </div>
    <div id="schedulePreview" class="schedule-preview">${s.schedulePreviewDefault}</div>
  </div>

  <div class="schedule-box" style="background:#f0fdf4;border-color:#a7f3d0">
    <div class="schedule-title" style="color:#065f46">${s.paymentMethodLabel}</div>
    <div id="paymentMethodPicker">${paymentMethodBoxHtml()}</div>
  </div>

  <label>${s.notes}</label><textarea id="notes" rows="2" placeholder="${s.notesPh}"></textarea>
  <div class="summary" id="checkoutSummary">${checkoutSummaryHtml()}</div>
  <button class="checkout" type="submit">${s.confirmOrder}</button>
 </form>`;
  setupScheduleDefaults();
  if (userProfile) {
    if (userProfile.name) document.getElementById("name").value = userProfile.name;
    if (userProfile.phone) document.getElementById("phone").value = userProfile.phone;
    if (userProfile.address) document.getElementById("address").value = userProfile.address;
  }
}
// كيبني تفصيل حساب المجموع فصفحة إتمام الطلب (تكلفة اليوم × عدد الأيام الحقيقي المختار، وخصم الباقة إلا كان)
// باش الزبون يشوف بعينيه كيفاش تحسب نسبة 10%/20% ديال الباقة، ماشي غير رقم نهائي بلا تفصيل
function checkoutSummaryHtml() {
  const s = t(lang);
  const p = PLANS_META.find((x) => x.id === plan);
  const days = actualDays() ?? p.days;
  return `
   <div class="sumrow"><span>${s.dailyCost}</span><b>${money(dailyTotal())}</b></div>
   <div class="sumrow"><span>${s.planDuration}</span><b>× ${days}</b></div>
   ${p.discount ? `<div class="sumrow" style="color:#047857"><span>${s.planDiscount}</span><b>-${p.discount * 100}%</b></div>` : ""}
   <div class="sumrow total"><span>${s.subscriptionTotal}</span><b id="checkoutTotalDisplay">${money(checkoutTotal())}</b></div>`;
}
function closeCheckout() {
  document.getElementById("checkoutModal").classList.remove("show");
}
/* ---------- طريقة الأداء ---------- */
function enabledPaymentMethods() {
  return PAYMENT_METHODS.filter((pm) => (paymentMethodsConfig[pm.id]?.enabled ?? true) !== false);
}
function paymentMethodBoxHtml() {
  const s = t(lang);
  const list = enabledPaymentMethods();
  const selected = PAYMENT_METHODS.find((p) => p.id === paymentMethod);
  const cfg = paymentMethod ? paymentMethodsConfig[paymentMethod] || {} : null;
  return `
   <button type="button" class="pay-toggle" onclick="togglePaymentPicker()">
     <span>${selected ? paymentIconHtml(selected) + " " + s.paymentMethods[selected.id] : s.choosePaymentMethod}</span>
     <span>${paymentPickerOpen ? "▲" : "▼"}</span>
   </button>
   ${
     paymentPickerOpen
       ? `<div class="pay-list">${list
           .map(
             (pm) =>
               `<div class="pay-item ${paymentMethod === pm.id ? "active" : ""}" onclick="selectPaymentMethod('${pm.id}')">${paymentIconHtml(pm)} ${
                 s.paymentMethods[pm.id]
               }</div>`
           )
           .join("")}</div>`
       : ""
   }
   ${
     cfg && (cfg.rib || cfg.holder || cfg.note)
       ? `<div class="notice pay-info" style="margin-top:10px">
       <b>${s.paymentInstructionsTitle}</b>
       ${
         cfg.rib
           ? `<div class="pay-info-row">
              <div><span>${s.paymentRibLabel}</span><b class="pay-info-value">${escapeHtml(cfg.rib)}</b></div>
              <button type="button" class="copy-btn" data-copy="${escapeAttr(cfg.rib)}" onclick="copyToClipboard(this)">${s.copyBtn}</button>
            </div>`
           : ""
       }
       ${
         cfg.holder
           ? `<div class="pay-info-row">
              <div><span>${s.paymentHolderLabel}</span><b class="pay-info-value">${escapeHtml(cfg.holder)}</b></div>
              <button type="button" class="copy-btn" data-copy="${escapeAttr(cfg.holder)}" onclick="copyToClipboard(this)">${s.copyBtn}</button>
            </div>`
           : ""
       }
       ${cfg.note ? `<div class="pay-info-note">${escapeHtml(cfg.note)}</div>` : ""}
     </div>`
       : ""
   }`;
}
function togglePaymentPicker() {
  paymentPickerOpen = !paymentPickerOpen;
  const el = document.getElementById("paymentMethodPicker");
  if (el) el.innerHTML = paymentMethodBoxHtml();
}
function selectPaymentMethod(id) {
  paymentMethod = id;
  paymentPickerOpen = false;
  const el = document.getElementById("paymentMethodPicker");
  if (el) el.innerHTML = paymentMethodBoxHtml();
}
// كيحسب تاريخ النهاية تلقائياً بناءً على مدة الباقة المختارة (يومي = يوم، أسبوعي = 7 أيام، شهري = 30 يوم)
function planEndDate(fromValue) {
  const p = PLANS_META.find((x) => x.id === plan);
  const start = new Date(fromValue + "T00:00:00");
  const end = new Date(start);
  end.setDate(end.getDate() + (p.days - 1));
  return end.toISOString().slice(0, 10);
}
function setupScheduleDefaults() {
  const today = new Date().toISOString().slice(0, 10);
  const from = document.getElementById("dateFrom"),
    to = document.getElementById("dateTo");
  if (from && to) {
    from.min = today;
    to.min = today;
    if (!from.value) from.value = today;
    // تاريخ النهاية كيتحسب تلقائياً حسب الباقة المختارة (يومي/أسبوعي/شهري) باش المجموع فصفحة إتمام الطلب يبان مباشرة مطابق للي بان فالسلة
    if (!to.value) to.value = planEndDate(from.value);
    to.min = from.value;
    updateSchedulePreview();
  }
}
// كيتنفذ ملي الزبون يبدل تاريخ البداية — كيعاود يحسب تاريخ النهاية تلقائياً حسب مدة الباقة، وكيحدث المجموع فالوقت الحقيقي
function onDateFromChange() {
  const from = document.getElementById("dateFrom"),
    to = document.getElementById("dateTo");
  if (from && from.value) {
    to.min = from.value;
    to.value = planEndDate(from.value);
  }
  updateSchedulePreview();
}
function updateSchedulePreview() {
  const s = t(lang);
  const from = document.getElementById("dateFrom")?.value,
    to = document.getElementById("dateTo")?.value;
  const time = document.getElementById("deliveryTime")?.value;
  const box = document.getElementById("schedulePreview");
  const summaryBox = document.getElementById("checkoutSummary");
  if (summaryBox) summaryBox.innerHTML = checkoutSummaryHtml();
  if (!box) return;
  if (!from || !to || !time) {
    box.textContent = s.schedulePreviewDefault;
    return;
  }
  if (to < from) {
    box.textContent = s.scheduleInvalid;
    return;
  }
  box.innerHTML = s.schedulePreview(formatDate(new Date(from + "T00:00:00")), formatDate(new Date(to + "T00:00:00")), time);
}

function useMyLocation() {
  const s = t(lang);
  const btn = document.getElementById("locBtn");
  const status = document.getElementById("locStatus");
  const field = document.getElementById("address");
  if (!btn || !status || !field) return;

  if (!window.isSecureContext && location.hostname !== "localhost") {
    status.textContent = s.locSecure;
    status.style.color = "#dc2626";
    return;
  }
  if (!navigator.geolocation) {
    status.textContent = s.locUnsupported;
    status.style.color = "#dc2626";
    return;
  }

  btn.disabled = true;
  btn.textContent = s.locWaiting;
  status.style.color = "#064e3b";
  status.textContent = s.locPermissionNote;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const { latitude, longitude } = pos.coords;
      const mapLinkField = document.getElementById("mapLink");
      if (mapLinkField) mapLinkField.value = `https://www.google.com/maps?q=${latitude},${longitude}`;
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&accept-language=${lang}&zoom=18`
        );
        const data = await res.json();
        field.value = data.display_name || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
        status.style.color = "#047857";
        status.textContent = s.locSuccess;
      } catch (e) {
        field.value = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
        status.style.color = "#047857";
        status.textContent = s.locSuccessCoords;
      }
      btn.disabled = false;
      btn.textContent = s.locRefresh;
    },
    (err) => {
      btn.disabled = false;
      btn.textContent = s.locRetry;
      status.style.color = "#dc2626";
      if (err.code === 1) status.textContent = s.locDenied;
      else if (err.code === 3) status.textContent = s.locTimeout;
      else status.textContent = s.locFailed;
    },
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 }
  );
}

async function submitOrder(e) {
  e.preventDefault();
  const s = t(lang);
  const phone = normalizePhone(document.getElementById("phone").value);
  if (!PHONE_RE.test(phone)) {
    alert(s.phoneInvalid);
    return;
  }
  const dateFrom = document.getElementById("dateFrom").value;
  const dateTo = document.getElementById("dateTo").value;
  const deliveryTime = document.getElementById("deliveryTime").value;
  if (!dateFrom || !dateTo || !deliveryTime) {
    alert(s.scheduleMissing);
    return;
  }
  if (dateTo < dateFrom) {
    alert(s.scheduleDateOrder);
    return;
  }
  if (!paymentMethod) {
    alert(s.paymentMethodRequired);
    return;
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = s.sendingOrder;
  }

  const durationDays = actualDays() || 1;
  const name = document.getElementById("name").value.trim();
  const address = document.getElementById("address").value.trim();
  const mapLink = document.getElementById("mapLink")?.value || "";

  const order = {
    uid: currentUser ? currentUser.uid : null,
    customer: {
      name,
      phone,
      address,
      mapLink,
      notes: document.getElementById("notes").value.trim(),
    },
    schedule: { dateFrom, dateTo, deliveryTime },
    plan,
    durationDays,
    paymentMethod,
    paymentMethodLabel: s.paymentMethods[paymentMethod] || paymentMethod,
    lang,
    items: cartItems().map((x) => ({ name: x.name, price: x.price, qty: x.qty })),
    total: checkoutTotal(),
    status: "قيد المراجعة",
    createdAt: serverTimestamp(),
  };

  try {
    const ref = await addDoc(collection(db, "orders"), order);
    await maybeCreateMembership(order, ref.id);
    if (currentUser) {
      await awardOrderPoints(currentUser.uid, order, ref.id);
    }
    // نحفظو معلومات الزبون (الاسم والعنوان) فحسابو باش تتعبى تلقائياً فالمرة الجاية
    if (currentUser) {
      try {
        await setDoc(doc(db, "users", currentUser.uid), { name, address, phone }, { merge: true });
        userProfile = { ...userProfile, name, address, phone };
      } catch (e) {
        /* ما توقفش الطلب إلا فشل حفظ الملف الشخصي */
      }
    }
    cart = {};
    closeCheckout();
    document.getElementById("cartPanel").innerHTML = "";
    document.getElementById("mobileCart").style.display = "none";
    document.getElementById(
      "meals"
    ).innerHTML = `<div class="panel" style="grid-column:1/-1;text-align:center;padding:40px 20px"><div style="font-size:60px;margin-bottom:10px">✅</div><h2 style="color:#064e3b;margin:0 0 10px">${
      s.orderSuccessTitle
    }</h2><p>${s.orderRefLabel}: <b style="color:#047857">${ref.id.slice(0, 8).toUpperCase()}</b></p><p style="color:#78716c;font-size:14px">${s.orderWillContact(
      phone
    )}</p><button class="checkout" style="max-width:250px;margin:20px auto 0" onclick="render()">${s.newOrderBtn}</button></div>`;
  } catch (err) {
    alert(s.orderError);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = s.confirmOrder;
    }
  }
}

/* ---------- نظام الحساب: تسجيل الدخول / التسجيل / الملف الشخصي ---------- */
/* ═══════ نظام النقاط والولاء ═══════ */
function tierFor(lifetimePoints) {
  return TIERS.find((tr) => lifetimePoints >= tr.min && lifetimePoints <= tr.max) || TIERS[0];
}
function tierLabel(tierId, s) {
  return { bronze: s.tierBronze, silver: s.tierSilver, gold: s.tierGold, vip: s.tierVip }[tierId] || s.tierBronze;
}

async function awardPoints(uid, points, reason, orderId) {
  if (!points) return;
  try {
    await addDoc(collection(db, "pointsLog"), {
      uid,
      points,
      reason,
      orderId: orderId || null,
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    /* ما توقفش الطلب إلا فشل تسجيل النقط */
  }
}

async function fetchPointsSummary(uid) {
  // الرصيد الحقيقي = مجموع كل عمليات النقط ديال الزبون (كنحسبوه هنا، ماشي رقم مخزن قابل للتلاعب)
  let entries = [];
  try {
    const q = query(collection(db, "pointsLog"), where("uid", "==", uid));
    const snap = await getDocs(q);
    entries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    entries = [];
  }
  entries.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  let balance = 0,
    lifetime = 0;
  entries.forEach((en) => {
    const p = Number(en.points) || 0;
    balance += p;
    if (p > 0) lifetime += p;
  });
  return { balance, lifetime, entries };
}

async function awardOrderPoints(uid, order, orderId) {
  const s = t(lang);
  let profile;
  try {
    const snap = await getDoc(doc(db, "users", uid));
    profile = snap.exists() ? snap.data() : {};
  } catch (e) {
    profile = {};
  }

  const orderCountBefore = profile.orderCount || 0;
  const newOrderCount = orderCountBefore + 1;
  const isFirstOrder = orderCountBefore === 0;

  const monthKey = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  const sameMonth = profile.lastOrderMonthKey === monthKey;
  const ordersThisMonth = (sameMonth ? profile.ordersThisMonth || 0 : 0) + 1;

  const awards = [];
  if (isFirstOrder) awards.push({ points: pointsRules.firstOrderPoints, reason: s.reasonFirstOrder });

  const madPoints = Math.floor(order.total / pointsRules.perDirham);
  if (madPoints > 0) awards.push({ points: madPoints, reason: s.reasonOrderPoints(Math.round(order.total)) });

  let repeatBonus = 0;
  if (newOrderCount >= 2 && newOrderCount <= 4) repeatBonus = 10;
  else if (newOrderCount >= 5 && newOrderCount <= 9) repeatBonus = 20;
  else if (newOrderCount >= 10) repeatBonus = 30;
  if (repeatBonus) awards.push({ points: repeatBonus, reason: s.reasonRepeatBonus });

  if (newOrderCount === 3 && !profile.orderMilestone3Given) {
    awards.push({ points: pointsRules.streak3Bonus, reason: s.reasonStreak3 });
  }
  if (ordersThisMonth === 5) awards.push({ points: pointsRules.monthly5Bonus, reason: s.reasonMonthly5 });
  if (ordersThisMonth === 10) awards.push({ points: pointsRules.monthly10Bonus, reason: s.reasonMonthly10 });

  for (const a of awards) {
    await awardPoints(uid, a.points, a.reason, orderId);
  }

  // مكافأة الدعوة: إلا كان الزبون مدعو من صاحبو وهاد أول طلب ليه، صاحبو كيربح النقط
  if (isFirstOrder && profile.referredByUid && !profile.referralBonusGiven) {
    await awardPoints(profile.referredByUid, pointsRules.referralPoints, s.reasonReferral(order.customer.name), orderId);
  }

  try {
    await setDoc(
      doc(db, "users", uid),
      {
        orderCount: newOrderCount,
        ordersThisMonth,
        lastOrderMonthKey: monthKey,
        orderMilestone3Given: profile.orderMilestone3Given || newOrderCount >= 3,
        referralBonusGiven: profile.referralBonusGiven || (isFirstOrder && !!profile.referredByUid),
      },
      { merge: true }
    );
  } catch (e) {
    /* تجاهل */
  }
}

/* ---------- صفحة "مكافآتي" ---------- */
async function openRewards() {
  if (!currentUser) {
    pendingCheckoutAfterLogin = false;
    openAccount();
    return;
  }
  document.getElementById("accountModal").classList.remove("show");
  document.getElementById("rewardsModal").classList.add("show");
  document.getElementById("rewardsContent").innerHTML = `<div class="empty">⏳...</div>`;
  await renderRewardsPage();
}
function closeRewards() {
  document.getElementById("rewardsModal").classList.remove("show");
}

async function renderRewardsPage() {
  const s = t(lang);
  const uid = currentUser.uid;

  const [{ balance, lifetime, entries }, rewardsSnap, ordersSnap] = await Promise.all([
    fetchPointsSummary(uid),
    getDocs(query(collection(db, "rewards"), where("active", "==", true))).catch(() => ({ docs: [] })),
    getDocs(query(collection(db, "orders"), where("uid", "==", uid))).catch(() => ({ docs: [] })),
  ]);

  const rewards = rewardsSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.pointsCost - b.pointsCost);
  const orders = ordersSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

  const tier = tierFor(lifetime);
  const nextReward = rewards.find((r) => r.pointsCost > balance);
  const cheapestCost = rewards.length ? rewards[0].pointsCost : null;
  const progressTarget = nextReward ? nextReward.pointsCost : cheapestCost;
  const progressPct = progressTarget ? Math.max(0, Math.min(100, Math.round((balance / progressTarget) * 100))) : 100;

  const referralLink = `${window.location.origin}${window.location.pathname}?ref=${userProfile?.referralCode || ""}`;

  const rewardsHtml = rewards.length
    ? rewards
        .map(
          (r) => `<div class="reward-card">
      <div class="reward-name">${escapeHtml(r.name)}</div>
      ${r.description ? `<div class="reward-desc">${escapeHtml(r.description)}</div>` : ""}
      <div class="reward-bottom">
        <span class="reward-cost">${r.pointsCost} ${s.pointsLabel}</span>
        <button class="add" ${balance < r.pointsCost ? "disabled style='opacity:.4;cursor:not-allowed'" : ""} onclick="redeemReward('${r.id}')">${s.redeemBtn}</button>
      </div>
    </div>`
        )
        .join("")
    : "";

  const historyHtml = entries.length
    ? entries
        .slice(0, 20)
        .map(
          (en) =>
            `<div class="history-row"><span>${escapeHtml(en.reason || "")}</span><b style="color:${
              en.points >= 0 ? "#047857" : "#dc2626"
            }">${en.points >= 0 ? "+" : ""}${en.points}</b></div>`
        )
        .join("")
    : `<div class="empty" style="padding:20px">${s.noPointsHistory}</div>`;

  const unratedOrders = orders.filter((o) => !o.reviewed).slice(0, 5);
  const ordersHtml = unratedOrders.length
    ? unratedOrders
        .map(
          (o) =>
            `<div class="history-row"><span>${formatDate(o.schedule?.dateFrom || o.createdAt)} — ${money(o.total)}</span><button class="link-btn" onclick="openRateOrder('${
              o.id
            }')">${s.rateOrder}</button></div>`
        )
        .join("")
    : orders.length
    ? ""
    : `<div class="empty" style="padding:20px">${s.noOrdersYet}</div>`;

  document.getElementById("rewardsContent").innerHTML = `
   <div class="modal-head"><h3>${s.rewardsTitle}</h3><button class="close" onclick="closeRewards()">×</button></div>
   <div class="points-hero">
     <div class="points-balance">${balance} <small>${s.pointsLabel}</small></div>
     <div class="points-tier">${tierLabel(tier.id, s)}</div>
   </div>
   <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${progressPct}%"></div></div>
   <p style="text-align:center;font-size:13px;color:#57534e;margin:8px 0 20px">
     ${nextReward ? s.progressToNext(nextReward.pointsCost - balance, escapeHtml(nextReward.name)) : rewards.length ? s.allRewardsUnlocked : ""}
   </p>

   ${rewards.length ? `<h4 style="margin:16px 0 10px;color:#064e3b">${s.availableRewards}</h4><div class="rewards-grid">${rewardsHtml}</div>` : ""}

   <div class="referral-box">
     <div style="font-weight:900;margin-bottom:4px">${s.inviteFriend}</div>
     <div style="font-size:12px;opacity:.85;margin-bottom:10px">${s.inviteFriendDesc}</div>
     <button type="button" class="location-btn" style="width:100%;justify-content:center" onclick="copyReferralLink('${referralLink}')">${s.copyReferralLink}</button>
   </div>

   ${
     unratedOrders.length
       ? `<h4 style="margin:20px 0 10px;color:#064e3b">${s.myOrdersToRate}</h4><div class="history-list">${ordersHtml}</div>`
       : ""
   }

   <h4 style="margin:20px 0 10px;color:#064e3b">${s.pointsHistory}</h4>
   <div class="history-list">${historyHtml}</div>
  `;
}

function copyReferralLink(link) {
  const s = t(lang);
  navigator.clipboard
    .writeText(link)
    .then(() => alert(s.copied))
    .catch(() => alert(link));
}

async function redeemReward(rewardId) {
  const s = t(lang);
  const uid = currentUser.uid;
  const { balance } = await fetchPointsSummary(uid);
  let reward;
  try {
    const snap = await getDoc(doc(db, "rewards", rewardId));
    if (!snap.exists()) return;
    reward = snap.data();
  } catch (e) {
    return;
  }
  if (balance < reward.pointsCost) {
    alert(s.notEnoughPoints);
    return;
  }
  const code = "WJ" + Math.random().toString(36).slice(2, 8).toUpperCase();
  try {
    await awardPoints(uid, -reward.pointsCost, s.reasonRedeem(reward.name));
    await addDoc(collection(db, "redemptions"), {
      uid,
      rewardId,
      rewardName: reward.name,
      pointsCost: reward.pointsCost,
      code,
      status: "pending",
      createdAt: serverTimestamp(),
    });
    document.getElementById("rewardsContent").innerHTML = `
      <div class="modal-head"><h3>${s.redeemSuccessTitle}</h3><button class="close" onclick="closeRewards()">×</button></div>
      <div class="notice" style="text-align:center">
        <div style="font-size:15px;margin-bottom:10px">${s.redeemCodeNote}</div>
        <div style="font-size:26px;font-weight:900;letter-spacing:3px;color:#064e3b">${code}</div>
      </div>
      <button class="checkout" style="margin-top:16px" onclick="closeRewards()">${s.closeRedeem}</button>`;
  } catch (e) {
    alert(s.notEnoughPoints);
  }
}

/* ---------- تقييم الطلب ---------- */
let ratingValue = 5;
function openRateOrder(orderId) {
  const s = t(lang);
  document.getElementById("rewardsModal").classList.remove("show");
  document.getElementById("rateModal").classList.add("show");
  ratingValue = 5;
  document.getElementById("rateContent").innerHTML = `
   <div class="modal-head"><h3>${s.rateModalTitle}</h3><button class="close" onclick="closeRateOrder()">×</button></div>
   <div id="starsRow" style="text-align:center;font-size:34px;margin:16px 0;letter-spacing:6px"></div>
   <textarea id="rateComment" rows="2" placeholder="..."></textarea>
   <button class="checkout" style="margin-top:14px" onclick="submitRating('${orderId}')">${s.rateSubmit}</button>`;
  renderStars();
}
function renderStars() {
  const row = document.getElementById("starsRow");
  if (!row) return;
  row.innerHTML = [1, 2, 3, 4, 5]
    .map((n) => `<span style="cursor:pointer;color:${n <= ratingValue ? "#fbbf24" : "#e7e5e4"}" onclick="setRating(${n})">★</span>`)
    .join("");
}
function setRating(n) {
  ratingValue = n;
  renderStars();
}
function closeRateOrder() {
  document.getElementById("rateModal").classList.remove("show");
}
async function submitRating(orderId) {
  const s = t(lang);
  const comment = document.getElementById("rateComment").value.trim();
  try {
    await setDoc(doc(db, "orders", orderId), { reviewed: true, rating: ratingValue, reviewComment: comment }, { merge: true });
    await awardPoints(currentUser.uid, pointsRules.reviewPoints, s.reasonReview, orderId);
    document.getElementById("rateContent").innerHTML = `<div class="notice" style="text-align:center;font-size:16px">${s.rateThanks}</div>
     <button class="checkout" style="margin-top:14px" onclick="closeRateOrder()">${s.closeRedeem}</button>`;
  } catch (e) {
    alert(s.notEnoughPoints);
  }
}


/* ═══════ الدردشة مع الدعم ═══════ */
function renderChatMessages(messages) {
  const s = t(lang);
  const box = document.getElementById("chatMessages");
  if (!box) return;
  box.innerHTML = messages.length
    ? messages
        .map(
          (m) =>
            `<div class="chat-bubble ${m.senderRole === "customer" ? "chat-mine" : "chat-theirs"}">${
              m.imageData
                ? `<img src="${m.imageData}" class="chat-image" onclick="window.open(this.src, '_blank')">`
                : `<div class="chat-text">${escapeHtml(m.text)}</div>`
            }</div>`
        )
        .join("")
    : `<div class="empty" style="padding:30px 10px">${s.supportEmpty}</div>`;
  box.scrollTop = box.scrollHeight;
}

function openSupport() {
  if (!currentUser) {
    pendingSupportAfterLogin = true;
    openAccount();
    return;
  }
  const s = t(lang);
  document.getElementById("supportModal").classList.add("show");
  document.getElementById("supportContent").innerHTML = `
   <div class="modal-head"><h3>${s.supportTitle}</h3><button class="close" onclick="closeSupport()">×</button></div>
   <div id="chatMessages" class="chat-box"></div>
   <div id="supportImageStatus" style="font-size:12px;color:#78716c;margin-top:6px"></div>
   <form id="supportForm" style="display:flex;gap:8px;margin-top:10px" onsubmit="sendSupportMessage(event)">
    <button type="button" class="chat-photo-btn" onclick="document.getElementById('supportImageInput').click()" title="${s.supportSendImage}">📷</button>
    <input type="file" id="supportImageInput" accept="image/*" style="display:none" onchange="handleSupportImageSelected(event)">
    <input id="supportInput" placeholder="${s.supportPlaceholder}" style="flex:1" required autocomplete="off">
    <button class="add" type="submit">${s.supportSend}</button>
   </form>`;
  if (chatUnsubscribe) chatUnsubscribe();
  const uid = currentUser.uid;
  const q = query(collection(db, "messages"), where("threadId", "==", uid));
  chatUnsubscribe = onSnapshot(q, (snap) => {
    const messages = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
    renderChatMessages(messages);
    messages
      .filter((m) => m.senderRole === "admin" && !m.readByCustomer)
      .forEach((m) => updateDoc(doc(db, "messages", m.id), { readByCustomer: true }).catch(() => {}));
  });
}
function closeSupport() {
  document.getElementById("supportModal").classList.remove("show");
  if (chatUnsubscribe) {
    chatUnsubscribe();
    chatUnsubscribe = null;
  }
}
async function sendSupportMessage(e) {
  e.preventDefault();
  const input = document.getElementById("supportInput");
  const text = input.value.trim();
  if (!text || !currentUser) return;
  input.value = "";
  try {
    await addDoc(collection(db, "messages"), {
      threadId: currentUser.uid,
      senderUid: currentUser.uid,
      senderRole: "customer",
      text,
      readByCustomer: true,
      readByAdmin: false,
      createdAt: serverTimestamp(),
    });
  } catch (e2) {
    input.value = text; // نرجعو النص للحقل إلا فشل الإرسال
  }
}
// كيضغط الصورة (تصغير الأبعاد + JPEG) قبل ما يصيفطها، حيت ما كاينش Firebase Storage فهاد المشروع
// والرسائل كتخزن مباشرة فـ Firestore، فخاصنا الحجم يبقى صغير
function compressImageFile(file, maxDim = 1000, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read-failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("decode-failed"));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
async function handleSupportImageSelected(event) {
  const s = t(lang);
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || !currentUser) return;
  const statusBox = document.getElementById("supportImageStatus");
  if (statusBox) statusBox.textContent = s.supportImageSending;
  try {
    let dataUrl = await compressImageFile(file, 1000, 0.7);
    // إلا بقات الصورة كبيرة، نعاودو نضغطوها بجودة أقل
    if (dataUrl.length > 900000) dataUrl = await compressImageFile(file, 700, 0.5);
    if (dataUrl.length > 900000) {
      if (statusBox) statusBox.textContent = s.supportImageTooBig;
      return;
    }
    await addDoc(collection(db, "messages"), {
      threadId: currentUser.uid,
      senderUid: currentUser.uid,
      senderRole: "customer",
      text: "",
      imageData: dataUrl,
      readByCustomer: true,
      readByAdmin: false,
      createdAt: serverTimestamp(),
    });
    if (statusBox) statusBox.textContent = "";
  } catch (e) {
    if (statusBox) statusBox.textContent = s.supportImageFailed;
  }
}

// كتحدث نقطة التنبيه فزر ☰ وفعنصر "الدعم" داخل القائمة الجانبية على حساب hasUnreadSupport
function syncSupportBadgeUI() {
  const menuDot = document.getElementById("menuDot");
  if (menuDot) menuDot.style.display = hasUnreadSupport ? "block" : "none";
  const sideBadge = document.getElementById("sideSupportBadge");
  if (sideBadge) sideBadge.style.display = hasUnreadSupport ? "block" : "none";
}
function watchUnreadMessages(uid) {
  if (unreadUnsubscribe) unreadUnsubscribe();
  const q = query(collection(db, "messages"), where("threadId", "==", uid));
  unreadUnsubscribe = onSnapshot(q, (snap) => {
    hasUnreadSupport = snap.docs.some((d) => {
      const m = d.data();
      return m.senderRole === "admin" && !m.readByCustomer;
    });
    syncSupportBadgeUI();
  });
}
function stopWatchingUnreadMessages() {
  if (unreadUnsubscribe) {
    unreadUnsubscribe();
    unreadUnsubscribe = null;
  }
  // الإصلاح: بلا هاد السطر كانت نقطة التنبيه كتبقى بادية بعد تسجيل الخروج
  // حتى ولو ماكاينش رسائل غير مقروءة للمستخدم الجديد
  hasUnreadSupport = false;
  syncSupportBadgeUI();
}

function openAccount() {
  document.getElementById("accountModal").classList.add("show");
  if (currentUser && profileIncomplete) renderCompleteProfile();
  else if (currentUser) renderAccountProfile();
  else {
    authTab = "login";
    renderAccountAuth();
  }
}
function closeAccount() {
  document.getElementById("accountModal").classList.remove("show");
  pendingCheckoutAfterLogin = false;
}
function switchAuthTab(tabName) {
  authTab = tabName;
  renderAccountAuth();
}
function selectSignupGender(g) {
  signupGender = g;
  const male = document.getElementById("genderMaleOpt");
  const female = document.getElementById("genderFemaleOpt");
  if (male && female) {
    male.classList.toggle("active", g === "male");
    female.classList.toggle("active", g === "female");
  }
}

// أزرار المتابعة عبر Google / Apple — كتبان تحت نموذج الدخول والتسجيل بجوج
function socialLoginHtml(s) {
  return `
   <div class="social-divider"><span>${s.orContinueWith}</span></div>
   <button type="button" class="social-btn google-btn" onclick="signInWithGoogle()">
     <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
       <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
       <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
       <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
       <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
     </svg>
     <span>${s.continueWithGoogle}</span>
   </button>
   <button type="button" class="social-btn apple-btn" onclick="signInWithApple()">
     <svg width="16" height="16" viewBox="0 0 384 512" fill="currentColor" aria-hidden="true">
       <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/>
     </svg>
     <span>${s.continueWithApple}</span>
   </button>`;
}

function renderAccountAuth() {
  const s = t(lang);
  const notice = pendingCheckoutAfterLogin ? `<div class="notice" style="background:#fffbeb;border-color:#fde68a;color:#92400e">${s.loginRequiredNotice}</div>` : "";
  const el = document.getElementById("accountContent");
  if (authTab === "login") {
    el.innerHTML = `
     <div class="modal-head"><h3>${s.loginTitle}</h3><button class="close" onclick="closeAccount()">×</button></div>
     ${notice}
     <div class="auth-tabs">
       <button type="button" class="auth-tab active">${s.loginTab}</button>
       <button type="button" class="auth-tab" onclick="switchAuthTab('signup')">${s.signupTab}</button>
     </div>
     <form onsubmit="submitLogin(event)">
       <label>${s.phone}</label><input id="loginPhone" required type="tel" inputmode="tel" placeholder="${s.phonePh}">
       <label>${s.passwordLabel}</label><input id="loginPassword" required type="password" placeholder="${s.passwordPh}">
       <p id="authError" style="color:#dc2626;font-size:12px;margin:6px 0 0"></p>
       <button class="checkout" type="submit" style="width:100%;margin-top:14px">${s.loginBtn}</button>
     </form>
     ${socialLoginHtml(s)}`;
  } else {
    el.innerHTML = `
     <div class="modal-head"><h3>${s.signupTitle}</h3><button class="close" onclick="closeAccount()">×</button></div>
     ${notice}
     <div class="auth-tabs">
       <button type="button" class="auth-tab" onclick="switchAuthTab('login')">${s.loginTab}</button>
       <button type="button" class="auth-tab active">${s.signupTab}</button>
     </div>
     <form onsubmit="submitSignup(event)">
       <label>${s.phone}</label><input id="signupPhone" required type="tel" inputmode="tel" placeholder="${s.phonePh}">
       <label>${s.genderLabel}</label>
       <div class="gender-row">
         <div class="gender-opt active" id="genderMaleOpt" onclick="selectSignupGender('male')">${s.genderMale}</div>
         <div class="gender-opt" id="genderFemaleOpt" onclick="selectSignupGender('female')">${s.genderFemale}</div>
       </div>
       <label>${s.passwordLabel}</label><input id="signupPassword" required type="password" placeholder="${s.passwordPh}">
       <label>${s.confirmPassword}</label><input id="signupPassword2" required type="password" placeholder="${s.passwordPh}">
       <p id="authError" style="color:#dc2626;font-size:12px;margin:6px 0 0"></p>
       <button class="checkout" type="submit" style="width:100%;margin-top:14px">${s.signupBtn}</button>
     </form>
     ${socialLoginHtml(s)}`;
  }
  signupGender = "male";
}

// تسجيل الدخول عبر Google/Apple — نافذة منبثقة، وonAuthStateChanged كيدير الباقي (بما فيه فتح نموذج إكمال الملف الشخصي إلا كان الحساب جديد)
async function signInWithGoogle() {
  const s = t(lang);
  const errEl = document.getElementById("authError");
  try {
    await authReady;
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    if (err?.code !== "auth/popup-closed-by-user" && errEl) errEl.textContent = s.socialLoginError;
  }
}
async function signInWithApple() {
  const s = t(lang);
  const errEl = document.getElementById("authError");
  try {
    await authReady;
    await signInWithPopup(auth, appleProvider);
  } catch (err) {
    if (err?.code !== "auth/popup-closed-by-user" && errEl) errEl.textContent = s.socialLoginError;
  }
}

// نموذج إكمال الملف الشخصي — كيبان مرة وحدة بعد أول تسجيل دخول عبر Google/Apple باش الزبون يعطي رقم الهاتف والجنس
function renderCompleteProfile() {
  const s = t(lang);
  const el = document.getElementById("accountContent");
  el.innerHTML = `
   <div class="modal-head"><h3>${s.completeProfileTitle}</h3><button class="close" onclick="closeAccount()">×</button></div>
   <div class="notice">${s.completeProfileDesc}</div>
   <form onsubmit="submitCompleteProfile(event)">
     <label>${s.phone}</label><input id="completePhone" required type="tel" inputmode="tel" placeholder="${s.phonePh}">
     <label>${s.genderLabel}</label>
     <div class="gender-row">
       <div class="gender-opt active" id="genderMaleOpt" onclick="selectSignupGender('male')">${s.genderMale}</div>
       <div class="gender-opt" id="genderFemaleOpt" onclick="selectSignupGender('female')">${s.genderFemale}</div>
     </div>
     <p id="authError" style="color:#dc2626;font-size:12px;margin:6px 0 0"></p>
     <button class="checkout" type="submit" style="width:100%;margin-top:14px">${s.completeProfileBtn}</button>
   </form>
   <button type="button" class="link-btn" style="width:100%;margin-top:12px" onclick="logoutAccount()">${s.logoutBtn}</button>`;
  signupGender = "male";
}

async function submitCompleteProfile(e) {
  e.preventDefault();
  const s = t(lang);
  const errEl = document.getElementById("authError");
  const phone = normalizePhone(document.getElementById("completePhone").value);
  if (!PHONE_RE.test(phone)) {
    errEl.textContent = s.authPhoneInvalid;
    return;
  }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = s.signingUp;
  try {
    let referredByUid = null;
    if (incomingReferralCode) {
      try {
        const refQ = query(collection(db, "users"), where("referralCode", "==", incomingReferralCode), limit(1));
        const refSnap = await getDocs(refQ);
        if (!refSnap.empty) referredByUid = refSnap.docs[0].id;
      } catch (e) {
        /* تجاهل — الإكمال يكمل حتى لو فشل التحقق من كود الدعوة */
      }
    }
    const profileData = {
      phone,
      gender: signupGender,
      avatar: avatarFor(signupGender),
      referralCode: currentUser.uid.slice(0, 6).toUpperCase(),
      referredByUid,
      referralBonusGiven: false,
      orderCount: 0,
      ordersThisMonth: 0,
      lastOrderMonthKey: "",
      orderMilestone3Given: false,
      createdAt: serverTimestamp(),
    };
    await setDoc(doc(db, "users", currentUser.uid), profileData);
    userProfile = { ...profileData, createdAt: new Date().toISOString() };
    profileIncomplete = false;
    updateAccountButton();
    document.getElementById("accountModal").classList.remove("show");
    if (pendingCheckoutAfterLogin) {
      pendingCheckoutAfterLogin = false;
      openCheckout();
    }
    if (pendingSupportAfterLogin) {
      pendingSupportAfterLogin = false;
      openSupport();
    }
  } catch (err) {
    errEl.textContent = s.signupError;
    btn.disabled = false;
    btn.textContent = s.completeProfileBtn;
  }
}

async function submitLogin(e) {
  e.preventDefault();
  const s = t(lang);
  const errEl = document.getElementById("authError");
  const phone = normalizePhone(document.getElementById("loginPhone").value);
  const password = document.getElementById("loginPassword").value;
  if (!PHONE_RE.test(phone)) {
    errEl.textContent = s.authPhoneInvalid;
    return;
  }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = s.loggingIn;
  try {
    await authReady;
    await signInWithEmailAndPassword(auth, phoneToEmail(phone), password);
    // onAuthStateChanged غادي يدير الباقي (تحميل الملف الشخصي وإغلاق المودال)
  } catch (err) {
    errEl.textContent = s.loginError;
    btn.disabled = false;
    btn.textContent = s.loginBtn;
  }
}

async function submitSignup(e) {
  e.preventDefault();
  const s = t(lang);
  const errEl = document.getElementById("authError");
  const phone = normalizePhone(document.getElementById("signupPhone").value);
  const password = document.getElementById("signupPassword").value;
  const password2 = document.getElementById("signupPassword2").value;
  if (!PHONE_RE.test(phone)) {
    errEl.textContent = s.authPhoneInvalid;
    return;
  }
  if (password.length < 8) {
    errEl.textContent = s.authPasswordShort;
    return;
  }
  if (password !== password2) {
    errEl.textContent = s.authPasswordMismatch;
    return;
  }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = s.signingUp;
  try {
    await authReady;
    const cred = await createUserWithEmailAndPassword(auth, phoneToEmail(phone), password);

    // إلا جا الزبون من رابط دعوة (?ref=CODE)، كنقلبو على صاحب هاد الكود باش نربطو بيه
    let referredByUid = null;
    if (incomingReferralCode) {
      try {
        const refQ = query(collection(db, "users"), where("referralCode", "==", incomingReferralCode), limit(1));
        const refSnap = await getDocs(refQ);
        if (!refSnap.empty) referredByUid = refSnap.docs[0].id;
      } catch (e) {
        /* تجاهل — التسجيل يكمل حتى لو فشل التحقق من كود الدعوة */
      }
    }

    const profileData = {
      phone,
      gender: signupGender,
      avatar: avatarFor(signupGender),
      referralCode: cred.user.uid.slice(0, 6).toUpperCase(),
      referredByUid,
      referralBonusGiven: false,
      orderCount: 0,
      ordersThisMonth: 0,
      lastOrderMonthKey: "",
      orderMilestone3Given: false,
      createdAt: serverTimestamp(),
    };
    await setDoc(doc(db, "users", cred.user.uid), profileData);
    // onAuthStateChanged قد يكون قرا الوثيقة قبل ما يكتبها setDoc (سباق)، فكنثبتو
    // البيانات الصحيحة هنا مباشرة بدل ما نعتمدو غير على القراءة ديالو
    userProfile = { ...profileData, createdAt: new Date().toISOString() };
    updateAccountButton();
  } catch (err) {
    errEl.textContent = s.signupError;
    btn.disabled = false;
    btn.textContent = s.signupBtn;
  }
}

function logoutAccount() {
  signOut(auth);
  closeAccount();
}

function renderAccountProfile() {
  const s = t(lang);
  const el = document.getElementById("accountContent");
  const avatar = userProfile?.avatar || "👤";
  const phone = userProfile?.phone || "";
  const genderLabel = userProfile?.gender === "female" ? s.genderFemale : s.genderMale;
  el.innerHTML = `
   <div class="modal-head"><h3>${s.profileTitle}</h3><button class="close" onclick="closeAccount()">×</button></div>
   <div class="profile-head"><div class="avatar-circle">${avatar}</div><b style="font-size:16px">${escapeHtml(phone)}</b></div>
   <div class="profile-row"><span>${s.profilePhoneLabel}</span><b>${escapeHtml(phone)}</b></div>
   <div class="profile-row"><span>${s.profileGenderLabel}</span><b>${genderLabel}</b></div>
   ${
     membershipData
       ? `<button class="checkout" style="width:100%;margin-top:18px" onclick="openMembership()">${s.goToMembership}</button>`
       : `<div class="notice" style="margin-top:16px">${s.noMembershipYet}</div>`
   }
   <button class="checkout" style="width:100%;margin-top:12px;background:#f59e0b;color:#1c1917" onclick="openRewards()">${s.rewardsBtn}</button>
   <button class="link-btn" style="width:100%;margin-top:14px" onclick="logoutAccount()">${s.logoutBtn}</button>
   <button class="link-btn" style="width:100%;margin-top:8px;color:#dc2626" onclick="openDeleteAccountConfirm()">${s.deleteAccountBtn}</button>`;
}

/* ---------- حذف الحساب نهائياً ---------- */
function openDeleteAccountConfirm() {
  renderDeleteAccountConfirm();
}
function cancelDeleteAccount() {
  renderAccountProfile();
}
function renderDeleteAccountConfirm() {
  const s = t(lang);
  const el = document.getElementById("accountContent");
  el.innerHTML = `
   <div class="modal-head"><h3>${s.deleteAccountConfirmTitle}</h3><button class="close" onclick="closeAccount()">×</button></div>
   <div class="notice" style="background:#fef2f2;border-color:#fecaca;color:#991b1b">${s.deleteAccountWarning}</div>
   <form onsubmit="submitDeleteAccount(event)">
     <label>${s.deleteAccountPasswordLabel}</label>
     <input id="deleteAccountPassword" required type="password" placeholder="${s.passwordPh}">
     <p id="deleteAccountError" style="color:#dc2626;font-size:12px;margin:6px 0 0"></p>
     <button type="submit" style="width:100%;margin-top:14px;border:0;background:#dc2626;color:#fff;border-radius:999px;padding:12px;font-weight:800">${s.confirmDeleteBtn}</button>
     <button type="button" class="link-btn" style="width:100%;margin-top:10px" onclick="cancelDeleteAccount()">${s.cancelDeleteBtn}</button>
   </form>`;
}
async function submitDeleteAccount(e) {
  e.preventDefault();
  const s = t(lang);
  const errEl = document.getElementById("deleteAccountError");
  const password = document.getElementById("deleteAccountPassword").value;
  if (!currentUser || !userProfile) return;
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = s.deletingAccount;
  try {
    // إعادة التحقق من كلمة السر إجباري من Firebase قبل حذف أي حساب حساس
    const cred = EmailAuthProvider.credential(phoneToEmail(userProfile.phone), password);
    await reauthenticateWithCredential(currentUser, cred);
    const uid = currentUser.uid;
    // كنمسحو الملف الشخصي وبطاقة العضوية قبل حذف حساب Auth
    // (الطلبات كتبقى محفوظة كسجل تجاري للأدمين، وماشي مرتبطة ببيانات شخصية إضافية)
    try {
      await deleteDoc(doc(db, "members", uid));
    } catch (_) {}
    await deleteDoc(doc(db, "users", uid));
    await deleteUser(currentUser);
    closeAccount();
    alert(s.accountDeletedMsg);
  } catch (err) {
    errEl.textContent = s.deleteAccountError;
    btn.disabled = false;
    btn.textContent = s.confirmDeleteBtn;
  }
}

/* ---------- بطاقة العضوية (تلقائية بعد طلب من 3 أيام فما فوق) ---------- */
async function loadMembership(uid) {
  try {
    const snap = await getDoc(doc(db, "members", uid));
    membershipData = snap.exists() ? snap.data() : null;
  } catch (e) {
    membershipData = null;
  }
  updateAccountButton();
}

async function maybeCreateMembership(order, orderId) {
  if (!currentUser) return;

  // كنجمعو كل الطلبات ديال هاد الزبون باش نربطوهم فبطاقة عضوية واحدة
  // (بدل ما نبقاو نحسبو غير الطلب الأخير بوحدو)
  let totalDays = order.durationDays || 1;
  let minStart = order.schedule.dateFrom;
  let maxEnd = order.schedule.dateTo;
  try {
    const q = query(collection(db, "orders"), where("uid", "==", currentUser.uid));
    const snap = await getDocs(q);
    totalDays = 0;
    snap.forEach((docSnap) => {
      const o = docSnap.data();
      if (!o.schedule) return;
      totalDays += o.durationDays || 1;
      if (o.schedule.dateFrom < minStart) minStart = o.schedule.dateFrom;
      if (o.schedule.dateTo > maxEnd) maxEnd = o.schedule.dateTo;
    });
  } catch (e) {
    /* إلا فشل التجميع، كنكملو بمعطيات الطلب الحالي وحده */
  }
  if (totalDays < MEMBERSHIP_MIN_DAYS) return;

  const memberRef = doc(db, "members", currentUser.uid);
  let joinDate = new Date().toISOString();
  try {
    const existing = await getDoc(memberRef);
    if (existing.exists() && existing.data().joinDate) joinDate = existing.data().joinDate;
  } catch (e) {
    /* تجاهل */
  }

  const data = {
    uid: currentUser.uid,
    name: order.customer.name,
    phone: userProfile?.phone || order.customer.phone,
    gender: userProfile?.gender || "male",
    avatar: userProfile?.avatar || "👨",
    startDate: minStart,
    endDate: maxEnd,
    totalDays,
    orderId,
    plan: order.plan || null,
    joinDate,
    updatedAt: serverTimestamp(),
  };
  try {
    await setDoc(memberRef, data, { merge: true });
    membershipData = data;
    updateAccountButton();
  } catch (e) {
    /* الفشل هنا ما كيوقفش الطلب — الطلب راه تسجل بنجاح فـ orders */
  }
}

function openMembership() {
  const s = t(lang);
  if (!membershipData) return;
  document.getElementById("accountModal").classList.remove("show");
  document.getElementById("membershipModal").classList.add("show");
  renderMembershipCard();
  clearInterval(countdownInterval);
  countdownInterval = setInterval(renderCountdownOnly, 1000);
}
function closeMembership() {
  document.getElementById("membershipModal").classList.remove("show");
  clearInterval(countdownInterval);
  countdownInterval = null;
}
function backToProfileFromMembership() {
  document.getElementById("membershipModal").classList.remove("show");
  clearInterval(countdownInterval);
  countdownInterval = null;
  openAccount();
}

function remainingParts(endDate) {
  const end = new Date(endDate + "T23:59:59");
  const diff = end.getTime() - Date.now();
  if (diff <= 0) return null;
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return { days, hours, minutes, seconds };
}

function renderMembershipCard() {
  const s = t(lang);
  const m = membershipData;
  if (!m) return;
  const memberId = "MB-" + (currentUser?.uid || "").slice(0, 6).toUpperCase();
  document.getElementById("membershipContent").innerHTML = `
   <div class="modal-head"><h3>${s.cardSubtitle}</h3><button class="close" onclick="closeMembership()">×</button></div>
   <div class="member-card">
     <div class="member-card-brand">وجبتي <span style="opacity:.6;font-size:12px">Wajbati</span></div>
     <div class="member-card-name">${m.avatar || ""} ${escapeHtml(m.name || m.phone || "")}</div>
     <div class="member-card-row"><span>${s.memberSince}</span><b>${formatDate(m.joinDate)}</b></div>
     <div class="member-card-row"><span>${s.validUntil}</span><b>${formatDate(m.endDate + "T00:00:00")}</b></div>
     ${m.plan && s.plans[m.plan] ? `<div class="member-card-row"><span>${s.currentPlanLabel}</span><b>${s.plans[m.plan][0]}</b></div>` : ""}
     <div id="countdownWrap"></div>
     <div class="member-card-id">${memberId}</div>
   </div>
   <button class="link-btn" style="width:100%;margin-top:14px;color:#dc2626" onclick="cancelSubscription()">${s.cancelSubscriptionBtn}</button>
   <button class="link-btn" style="width:100%;margin-top:8px" onclick="backToProfileFromMembership()">${s.backToProfile}</button>`;
  renderCountdownOnly();
}

function renderCountdownOnly() {
  const s = t(lang);
  const wrap = document.getElementById("countdownWrap");
  if (!wrap || !membershipData) return;
  const parts = remainingParts(membershipData.endDate);
  if (!parts) {
    wrap.innerHTML = `
     <div class="notice" style="margin-top:14px;background:rgba(255,255,255,.12);color:#fff;border-color:transparent">${s.membershipExpired}</div>
     <button class="renew-btn" onclick="renewSubscription()">${s.renewSubscriptionBtn}</button>`;
    clearInterval(countdownInterval);
    countdownInterval = null;
    return;
  }
  wrap.innerHTML = `
   <div style="position:relative;font-size:11px;opacity:.75;margin-top:10px">${s.membershipRemaining}</div>
   <div class="countdown">
     <div class="countdown-box"><b>${parts.days}</b><span>${s.countdownDays}</span></div>
     <div class="countdown-box"><b>${parts.hours}</b><span>${s.countdownHours}</span></div>
     <div class="countdown-box"><b>${parts.minutes}</b><span>${s.countdownMinutes}</span></div>
     <div class="countdown-box"><b>${parts.seconds}</b><span>${s.countdownSeconds}</span></div>
   </div>`;
}

// كيلغي اشتراك الزبون فالباقة الحالية — كيمسح بطاقة العضوية ديالو من قاعدة البيانات، دون ما يمس أي حاجة أخرى (النقاط، الطلبات، الحساب...)
async function cancelSubscription() {
  const s = t(lang);
  if (!currentUser || !membershipData) return;
  if (!confirm(s.cancelSubscriptionConfirm)) return;
  try {
    await deleteDoc(doc(db, "members", currentUser.uid));
    membershipData = null;
    clearInterval(countdownInterval);
    countdownInterval = null;
    document.getElementById("membershipModal").classList.remove("show");
    updateAccountButton();
    alert(s.cancelSubscriptionDone);
    openAccount();
  } catch (e) {
    alert(s.cancelSubscriptionError);
  }
}

// كيوجه الزبون باش يجدد الاشتراك: كيسد بطاقة العضوية والحساب، ويمشي لقائمة الأطباق باش يصاوب طلب جديد (البطاقة كتترجع تلقائياً بعد طلب من 3 أيام فما فوق)
function renewSubscription() {
  document.getElementById("membershipModal").classList.remove("show");
  document.getElementById("accountModal").classList.remove("show");
  const meals = document.getElementById("meals");
  if (meals) meals.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------- تعريض الدوال للـ HTML (الملف عبارة عن module) ---------- */
Object.assign(window, {
  setCategory,
  add,
  remove,
  removeAll,
  choosePlan,
  openCheckout,
  closeCheckout,
  updateSchedulePreview,
  onDateFromChange,
  togglePaymentPicker,
  selectPaymentMethod,
  copyToClipboard,
  useMyLocation,
  submitOrder,
  render,
  switchLang,
  openAccount,
  closeAccount,
  switchAuthTab,
  selectSignupGender,
  submitLogin,
  submitSignup,
  signInWithGoogle,
  signInWithApple,
  submitCompleteProfile,
  logoutAccount,
  openDeleteAccountConfirm,
  cancelDeleteAccount,
  submitDeleteAccount,
  openMembership,
  closeMembership,
  backToProfileFromMembership,
  cancelSubscription,
  renewSubscription,
  openRewards,
  closeRewards,
  copyReferralLink,
  redeemReward,
  openRateOrder,
  closeRateOrder,
  setRating,
  submitRating,
  openSupport,
  closeSupport,
  sendSupportMessage,
  handleSupportImageSelected,
  openSidebar,
  closeSidebar,
  openSidebarAction,
});

/* ---------- الاشتراك بقائمة الأطباق (تحديث فوري) ---------- */
const mealsQuery = query(collection(db, "meals"), orderBy("name"));
onSnapshot(
  mealsQuery,
  (snap) => {
    meals = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  },
  () => {
    document.getElementById("meals").innerHTML = `<div class="empty" style="grid-column:1/-1">⚠️ تعذر تحميل الأطباق / Échec du chargement.</div>`;
  }
);

/* ---------- الاشتراك بصورة وجبة اليوم (تحديث فوري بمجرد ما الأدمين يبدلها) ---------- */
onSnapshot(
  doc(db, "config", "dailyMeal"),
  (snap) => {
    dailyMealImage = snap.exists() ? snap.data().image || "" : "";
    renderDailyMealBanner();
  },
  () => {}
);

/* ---------- الاشتراك بإعدادات طرق الأداء (RIB/تفعيل) — تحديث فوري بمجرد ما الأدمين يبدلها ---------- */
onSnapshot(
  doc(db, "config", "paymentMethods"),
  (snap) => {
    paymentMethodsConfig = snap.exists() ? snap.data() || {} : {};
    const el = document.getElementById("paymentMethodPicker");
    if (el) el.innerHTML = paymentMethodBoxHtml();
  },
  () => {}
);

/* ---------- حالة تسجيل الدخول ---------- */
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (user) {
    // زبون داخل عبر Google/Apple ما عندوش وثيقة فـ users بعد (ماشي دخول بكلمة السر، فتلك الحالة submitSignup كيصاوبها هو)
    const isSocialProvider = user.providerData[0]?.providerId !== "password";
    try {
      const snap = await getDoc(doc(db, "users", user.uid));
      if (snap.exists()) {
        userProfile = snap.data();
        profileIncomplete = false;
      } else {
        userProfile = { phone: "", gender: "male", avatar: "👨" };
        profileIncomplete = isSocialProvider;
      }
    } catch (e) {
      userProfile = { phone: "", gender: "male", avatar: "👨" };
      profileIncomplete = isSocialProvider;
    }
    if (profileIncomplete) {
      // خاص الزبون يعطي رقم الهاتف والجنس قبل ما يكمل — نبقاو المودال مفتوح ونبانو ليه النموذج
      document.getElementById("accountModal").classList.add("show");
      renderCompleteProfile();
    } else {
      // إغلاق مودال الحساب فوراً وإكمال الطلب — ماشي خاصنا ننتظرو بطاقة العضوية باش الدخول يبان سريع
      document.getElementById("accountModal").classList.remove("show");
      if (pendingCheckoutAfterLogin) {
        pendingCheckoutAfterLogin = false;
        openCheckout();
      }
      if (pendingSupportAfterLogin) {
        pendingSupportAfterLogin = false;
        openSupport();
      }
    }
    updateAccountButton();
    loadMembership(user.uid); // كيكمل فالخلفية، وكيحدث الزر وحدو ملي يوصل
    watchUnreadMessages(user.uid);
  } else {
    userProfile = null;
    membershipData = null;
    profileIncomplete = false;
    stopWatchingUnreadMessages();
  }
  updateAccountButton();
});

applyStaticText();
renderCategories(); // كتبان الفئات فوراً، بلا ما تنتظر جواب Firestore ديال الأطباق
document.getElementById("year").textContent = new Date().getFullYear();

/* ---------- نظام النقاط: تحميل القواعد + التقاط رابط الدعوة ---------- */
getDoc(doc(db, "config", "pointsRules"))
  .then((snap) => {
    if (snap.exists()) pointsRules = { ...DEFAULT_POINTS_RULES, ...snap.data() };
  })
  .catch(() => {});

const urlParams = new URLSearchParams(window.location.search);
const incomingReferralCode = urlParams.get("ref") || null;
