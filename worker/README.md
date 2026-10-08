# مساعد CalmGastro: الخادم (Cloudflare Worker)

الموقع على GitHub Pages لا يستطيع حفظ مفاتيح سرية، لذلك يمر المساعد عبر Cloudflare Worker مجاني:

```
الزائر → نافذة «اسأل المساعد» → Cloudflare Worker (المفتاح هنا) → Gemini أو Workers AI → إجابة من معلومات الموقع فقط
```

## التشغيل لأول مرة (حوالي 10 دقائق، بدون برمجة)

1. **مفتاح Gemini المجاني:** افتح https://aistudio.google.com/apikey ثم **Create API key**. لا يحتاج بطاقة دفع. انسخ المفتاح ولا تضعه في أي ملف.
2. **حساب Cloudflare مجاني:** https://dash.cloudflare.com/sign-up
3. **إنشاء الـ Worker:** من القائمة اختر **Workers & Pages** ثم **Create** ثم **Create Worker**. سمّه `calmgastro-assistant` واضغط **Deploy**.
4. **لصق الكود:** اضغط **Edit code**، احذف الموجود، والصق محتوى `worker.js` كاملاً، ثم **Deploy**.
5. **ربط Workers AI (النموذج الاحتياطي):** من **Settings** ثم **Bindings** ثم **Add** اختر **Workers AI** واكتب في Variable name: `AI`.
6. **حفظ المفتاح:** من **Settings** ثم **Variables and Secrets** ثم **Add** اختر النوع **Secret**، والاسم `GEMINI_API_KEY`، والقيمة هي المفتاح من الخطوة 1.
7. **التأكد:** افتح `https://calmgastro-assistant.<حسابك>.workers.dev/health`، ويجب أن يظهر `"providers":["gemini","workers-ai"]`.
8. **أرسل الرابط** ليُضاف إلى الموقع في `CONFIG.assistant.endpoint` بهذا الشكل: `https://calmgastro-assistant.<حسابك>.workers.dev/chat`

بديل للمطورين: `npx wrangler login` ثم `npx wrangler deploy` ثم `npx wrangler secret put GEMINI_API_KEY` (الإعدادات في `wrangler.toml`).

## تحديث معلومات المنتج

لا يوجد ما تحدّثه في الـ Worker. المساعد يقرأ الموقع المنشور نفسه كل 5 دقائق:
- **الأسعار والعروض والمكونات ورقم الواتساب والتوصيل:** كتلة `product-data` في `index.html`.
- **النصوص (طريقة الاستخدام، التحذيرات، الأسئلة الشائعة…):** الأقسام المعلّمة بـ `data-kb`.

لمعرفة ما يعرفه المساعد الآن افتح: `https://calmgastro-assistant.<حسابك>.workers.dev/kb`

## الإعدادات الاختيارية (Settings ثم Variables)

| المتغير | الافتراضي | الاستخدام |
|---|---|---|
| `PROVIDERS` | `gemini,workers-ai` | ترتيب النماذج، والتالي يُستخدم تلقائياً إذا فشل الأول |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite` | نموذج Gemini |
| `WORKERS_AI_MODEL` | `@cf/meta/llama-4-scout-17b-16e-instruct` | النموذج الاحتياطي |
| `ALLOWED_ORIGINS` | `https://calmgastro.github.io` | المواقع المسموح لها باستخدام المساعد (أضف دومينك لاحقاً مفصولاً بفاصلة) |
| `SITE_URL` | `https://calmgastro.github.io/` | الصفحة التي تُقرأ منها المعرفة |

## اختبار المساعد الحقيقي

```
node test-live.mjs https://calmgastro-assistant.<حسابك>.workers.dev
```
يطرح 16 سؤالاً (لهجة سعودية، أسعار، جملة، أسئلة طبية، أسئلة خارج النطاق) ويطبع كل إجابة.
