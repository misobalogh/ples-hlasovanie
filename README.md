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

### Ako sa počítajú mená
Hlasujúci píšu meno a priezvisko ručne (zoznam žiakov nie je). Databáza z nich spraví kľúč bez diakritiky, veľkých písmen, interpunkcie a so zoradenými slovami, takže `Lucia Nováková`, `NOVAKOVA lucia` aj `Nováková  Lucia` sú jeden človek. Iné tvary (`Luciu Novákovú`) a preklepy (`Nowakova`) spája organizátor na `vysledky.html`: stránka navrhne podobné mená, dá sa spojiť aj ručne cez „Spojiť s…“, spojenie sa dá rozpojiť a nezmysly skryť.

Pozrieť surové hlasy: `select * from public.votes order by created_at desc;`

### Vymazať testovacie hlasy
```sql
delete from public.votes;
delete from public.name_merges;
delete from public.hidden_names;
```
Mobily, ktoré testovali, majú v prehliadači uložený príznak „už hlasoval“. Vymaž dáta stránky v prehliadači, alebo zmeň `STORAGE_PREFIX` v `config.js` (resetuje všetky zariadenia).

### Ručne otvoriť / zatvoriť hlasovanie
```sql
update public.settings set voting_open = false;  -- true = open
```

### Výsledky priamo v SQL
```sql
-- before manual merges; the results page applies merges and hidden names
select 'dievca' as category, girl_key as name, count(*) as votes from public.votes group by girl_key
union all
select 'chlapec', boy_key, count(*) from public.votes group by boy_key
order by category, votes desc;
```

## Obmedzenia

„Jeden hlas na mobil“ je založený na náhodnom ID v `localStorage`. Kto vymaže dáta prehliadača, použije anonymné okno alebo iný prehliadač, môže hlasovať znova, a technicky zdatný človek môže volať `cast_vote` s vymyslenými ID. Na školský ples to bežne stačí; ak treba viac, porovnajte počet hlasov s počtom účastníkov a sledujte `created_at` (nápadné dávky hlasov v rovnakej sekunde).
