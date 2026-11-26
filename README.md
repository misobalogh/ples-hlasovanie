# Kráľ a kráľovná plesu – hlasovanie

Statická webka (GitHub Pages) + Supabase. Žiadny build step.

| Súbor | Účel |
|---|---|
| `index.html` + `app.js` | verejné hlasovanie (cez QR) |
| `vysledky.html` + `admin.js` | výsledky a otvorenie/zatvorenie hlasovania (len organizátori) |
| `qr.html` | veľký QR kód na hlasovanie (tlač / projektor) |
| `config.js` | názov plesu, Supabase URL a publishable kľúč |
| `style.css` | spoločný dizajn |
| `setup.sql` | celá DB schéma, dá sa spustiť opakovane |

Bezpečnosť stojí výhradne na RLS a `SECURITY DEFINER` funkciách. V repe je iba publishable kľúč, ktorý je verejný z princípu.

## 1. Supabase

1. **SQL Editor → New query** → vlož celý obsah `setup.sql` → **Run**. (Pri opakovanom spustení sa nič nezduplikuje ani nezmaže.)
2. **Authentication → Sign In / Providers** → vypni **Allow new users to sign up** → Save.
3. **Authentication → Users → Add user → Create new user**: e-mail `admin@ples.local` (hodnota `ADMIN_EMAIL` v `config.js`), zvoľ silné heslo, zaškrtni **Auto Confirm User**. Toto heslo je spoločné pre všetkých organizátorov, na `vysledky.html` sa zadáva iba ono.
4. **SQL Editor**: pridaj tento e-mail do `admins` (snippet nižšie).

## 2. GitHub Pages

1. Vytvor repozitár na GitHube a nahraj doň obsah tohto priečinka (vrátane `.nojekyll`).
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch** → branch `main`, folder `/ (root)` → Save.
3. Po minúte beží na `https://<user>.github.io/<repo>/`:
   - hlasovanie: `.../`
   - výsledky: `.../vysledky.html`
   - QR kód: `.../qr.html` (QR ukazuje na priečinok, v ktorom leží `qr.html`; iná adresa: `qr.html?url=https://...` alebo `VOTE_URL` v `config.js`)

Názov plesu zmeníš v `config.js` (`EVENT_TITLE`). Pri ďalšom plese zmeň aj `STORAGE_PREFIX`, inak mobily z minulého roka budú mať príznak „už hlasoval“.

## SQL snippety

### Pridať admina (organizátora)
Používateľa najprv vytvor v Authentication → Users, potom:
```sql
insert into public.admins (email) values ('admin@ples.local')
on conflict do nothing;
```
Zmena hesla: Authentication → Users → používateľ → Reset password / Update user. Heslo zmeň, ak unikne alebo po plese.

### Zmeniť kandidátov
Premenovať placeholder:
```sql
update public.candidates set name = 'Skutočné Meno' where name = 'Lucia Nováková';
```
Nahradiť všetkých naraz (iba kým nie sú žiadne hlasy, inak najprv vymaž hlasy):
```sql
delete from public.votes;
delete from public.candidates;
insert into public.candidates (name, category, sort_order) values
  ('Meno Dievča 1', 'dievca', 1),
  ('Meno Dievča 2', 'dievca', 2),
  ('Meno Chlapec 1', 'chlapec', 1),
  ('Meno Chlapec 2', 'chlapec', 2);
```
Skryť kandidáta bez mazania (napr. odstúpil): `update public.candidates set active = false where id = 3;`
Pozrieť ID: `select * from public.candidates order by category, sort_order;`

### Vymazať testovacie hlasy
```sql
delete from public.votes;
```
Mobily, ktoré testovali, majú v prehliadači uložený príznak „už hlasoval“. Vymaž dáta stránky v prehliadači, alebo zmeň `STORAGE_PREFIX` v `config.js` (resetuje všetky zariadenia).

### Ručne otvoriť / zatvoriť hlasovanie
```sql
update public.settings set voting_open = false;  -- true = open
```

### Výsledky priamo v SQL
```sql
select c.category, c.name,
       count(v.id) as votes
from public.candidates c
left join public.votes v on v.girl_id = c.id or v.boy_id = c.id
group by c.id order by c.category, votes desc, c.name;
```

## Obmedzenia

„Jeden hlas na mobil“ je založený na náhodnom ID v `localStorage`. Kto vymaže dáta prehliadača, použije anonymné okno alebo iný prehliadač, môže hlasovať znova, a technicky zdatný človek môže volať `cast_vote` s vymyslenými ID. Na školský ples to bežne stačí; ak treba viac, porovnajte počet hlasov s počtom účastníkov a sledujte `created_at` (nápadné dávky hlasov v rovnakej sekunde).
