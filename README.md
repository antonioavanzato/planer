# Журнал Зала

PWA для тренера: карточки клиентов, журнал тренировок (упражнения, подходы, кг × повторы) и прогресс «с чего начали → куда пришли».

- Чистый HTML/CSS/JS, без сборки.
- Данные: Firebase Firestore с офлайн-кешем (работает без интернета, синхронизируется сам).
- Вход: Firebase Auth, почта + пароль.
- Бэкап: меню «Ещё» → экспорт/импорт JSON.

## Правила Firestore

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

## Деплой

GitHub Pages через `.github/workflows/pages.yml` (при пуше в `main`).
В Settings → Pages выбрать Source: **GitHub Actions**.
Домен `<user>.github.io` добавить в Firebase → Authentication → Settings → Authorized domains.

## Локально

```
python3 -m http.server 8000
```
