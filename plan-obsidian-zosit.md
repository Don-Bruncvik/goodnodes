# Plán: Obsidian plugin „Zošit" (pracovný názov)

Tento dokument je zadanie pre Claude Code. Čo je označené ako **[overiť]**, je predpoklad, ktorý sa má najprv potvrdiť v spike (M0), nie brať ako fakt.

## 1. Cieľ

Na iPade (Apple Pencil) v Obsidiane nahradiť GoodNotes pre dve použitia:

1. **PDF zošit**: otvoriť PDF ako dokument, normálne scrollovať strany, skákať na stranu, písať do nich perom.
2. **Nekonečné plátno**: obrovské plátno na jeden predmet. Nadpis v strede, okolo neho myšlienková mapa z lekcií, odrážky, obrázky. Voľný zoom a posun.

Pravidlá používania:

- Žiadne príkazy z príkazovej palety. Všetko cez ikonu v ribbone, menu „Nový súbor / priečinok" a klepnutie na súbor.
- **Pero kreslí, prsty vždy posúvajú a približujú.** Žiadne prepínanie na nástroj ruka.
- Horný panel nástrojov Excalidrawu v režime plátna ostáva presne taký, aký je (text, obrázok, tvary, šípky, farby...).
- Mimo rozsahu verzie 1: vlastné lasso, OCR, rozpoznávanie rukopisu, Android, zdieľanie. (Tvary v režime plátna dostaneme zadarmo z Excalidrawu.)

## 2. Prostredie a obmedzenia

- Obsidian na iPadOS (WKWebView). Plugin musí mať `isDesktopOnly: false`.
- Žiadne Node/Electron API (na mobile nefungujú). Len web API a Obsidian API.
- Súbory sú bežné súbory vo vaulte, lebo ich synchronizuje plugin Remotely Save (WebDAV na Nextcloud). Žiadne databázy ani binárne formáty mimo vaultu.
- Vault má stovky MB PDF. Výkon pri 300 stranách je kritický.
- Vývoj a základné testy na Macu (Obsidian desktop, myš). Gestá a pero sa dajú otestovať len na reálnom iPade.

## 3. Odporúčaná architektúra

Dva režimy, dva vlastné `ItemView`, spoločný panel nástrojov.

### Režim A: plátno
- Postaviť na komponente `@excalidraw/excalidraw` (MIT) vloženom do vlastného `ItemView`. Nie fork existujúceho pluginu Excalidraw (veľký a ťažko upraviteľný). **[overiť]** že komponent beží v Obsidian mobile.
- Vlastná vrstva gest nad komponentom: zachytávať pointer udalosti vo fáze capture na kontajneri.
  - `pointerType === 'pen'` (a `'mouse'` kvôli testovaniu na desktope): pustiť do Excalidrawu, nástroj `freedraw` zamknutý.
  - `pointerType === 'touch'`: zastaviť propagáciu a riešiť sami. Jeden prst = posun, dva prsty = pinch zoom okolo stredu dotykov. Hodnoty zapisovať cez API komponentu (`updateScene` s `appState.scrollX/scrollY/zoom`). **[overiť]** presné názvy API v aktuálnej verzii.
  - Ak je pero aktívne alebo práve zdvihnuté, ignorovať dotyky s veľkou kontaktnou plochou (dlaň).
- **Horný panel nástrojov Excalidrawu ostáva tak, ako je** (výber, tvary, šípka, čiara, pero, textové pole, obrázok, guma, farby, hrúbky, späť/vpred). Nič z neho neskrývať ani nenahrádzať. Pridať len malé tlačidlo na výber pozadia (sekcia 4b).
- Formát súboru: vlastná koncovka `.zosit` (JSON scény Excalidraw), zaregistrovaná cez `registerExtensions`. Nepoužívať `.excalidraw.md`, aby sa to nebilo s pluginom Excalidraw, ak ostane nainštalovaný. Obrázky vkladať ako súbory vo vaulte, nie base64 do JSON.

### Režim B: PDF
- Vlastný `ItemView`: vertikálny súvislý scroll strán, natívny pinch zoom a posun prstami.
- Vykresľovanie cez pdf.js. Obsidian ho má v sebe (`loadPdfJs()`). **[overiť]** dostupnosť a verziu.
- **Lazy render**: vykresľovať len viditeľné strany plus ± 2, ostatné uvoľniť z pamäte. Pri 300 stranách inak WebView spadne.
- Nad každou stranou vlastná kresliaca vrstva (canvas). Ťahy ukladať vektorovo v súradniciach strany (nezávislé od zoomu), vyhladzovať cez `perfect-freehand`. Pero kreslí, prsty scrollujú a približujú (CSS `touch-action` a pointer udalosti).
- Navigácia: indikátor „strana X / N", ťahateľný posuvník, skok na stranu zadaním čísla, bočný panel s miniatúrami (v2).
- Anotácie do **sidecar súboru** `<názov>.pdf.zosit.json`. Originálne PDF sa nemení. Export „PDF s poznámkami" cez `pdf-lib` ako voliteľná funkcia (v M3).
- Otvorenie: ribbon ikona „Otvoriť PDF ako zošit" a položka v kontextovom menu PDF súboru. Nechať Obsidianu jeho vlastné zobrazenie PDF.

### Záloha, ak by M0 ukázal, že Excalidraw v Obsidiane nefunguje dobre
Spoločný vlastný renderer: canvas 2D s transformáciou (posun/zoom), `perfect-freehand` na ťahy, text a obrázky ako jednoduché objekty. Strácame hotové texty a obrázky z Excalidrawu, získame úplnú kontrolu nad gestami.

## 4. Spoločné funkcie

- Ukladanie s debounce (~1 s po poslednom ťahu), zápis len ak sa obsah zmenil, atomicky. Nikdy nezapisovať počas načítavania.
- Pri načítaní súboru zmeneného zvonka (synchronizácia) znovu načítať, ak v zobrazení nie sú neuložené zmeny.
- Nastavenia pluginu: predvolená farba a hrúbka pera, citlivosť odmietania dlane, zapnúť/vypnúť vyhladzovanie.
- Tmavá/svetlá téma podľa Obsidianu.

### 4a. Zmazanie preškrtnutím (v oboch režimoch)

Ak preškrtneš napísané slovo perom, slovo sa zmaže.

- Rozpoznať „škrtanie": ťah s viacerými rýchlymi zmenami smeru (cik-cak), ktorý je malý v pomere k počtu zmien. Východiskový prah: aspoň 4 až 5 zmien smeru. Jeden alebo dve čiary cez text ho nesmú spustiť, treba poriadne zaškrtať. **[overiť]** prahy na reálnom rukopise, vyladiť s používateľom.
- Zmazať sa majú ťahy, ktoré škrtanie dostatočne pokrýva (východiskovo aspoň ~60 % ich dĺžky alebo plochy je pod škrtaním). Ťahy mimo škrtania sa nesmú dotknúť.
- Škrtanie samo po zmazaní zmizne. Ak pod ním nie je nič na zmazanie, ostane ako obyčajný ťah (bežné čmáranie nesmie nič mazať).
- Jeden krok späť vráti zmazané ťahy aj zruší škrtanie naraz.
- V režime plátna sa týka rukou písaných ťahov a voliteľne aj textových polí. V režime PDF len ťahov poznámok, nie textu samotného PDF.
- Nastavenia: zapnúť/vypnúť funkciu, citlivosť (počet zmien smeru a miera pokrytia).
- Rizikové miesto: tieňovanie a šrafovanie môže vyzerať ako škrtanie. Preto prah pokrytia a možnosť funkciu vypnúť.

### 4b. Pozadie plátna (len režim plátna)

- Voľby: **prázdne**, **štvorčeky** (štvorcovaný papier), **bodky** (ako v GoodNotes).
- Tlačidlo na výber pozadia pridať k hornému panelu. Voľba, veľkosť rastra a farba sa ukladajú do súboru `.zosit`, takže sa prenesú na iné zariadenie.
- Raster sa kreslí za scénou a musí sa pri posune a zoome správať ako súčasť plátna (škáluje sa a posúva spolu s ním). **[overiť]**, či sa dá plátno Excalidrawu urobiť priehľadné nad vlastnou vrstvou, alebo či treba kresliť raster inak. Excalidraw má vlastnú mriežku (štvorčeky), bodky sú nové.
- V exporte obrázka alebo PDF môže byť raster voliteľný.

## 5. Milníky

**M0 – Spike (najprv, výstup: krátka správa „čo funguje, čo nie")**
Kostra pluginu z `obsidian-sample-plugin`, nahratá na iPad. Overiť:
1. Komponent Excalidraw sa vykreslí v Obsidian mobile.
2. `pointerType` rozlišuje pero a dotyk spoľahlivo.
3. Pinch zoom cez `updateScene` je plynulý (cieľ: žiadne viditeľné sekanie).
4. pdf.js: vykreslenie jednej strany a výkon pri 300 stranách s lazy renderom.
5. Remotely Save synchronizuje súbory `.zosit` a sidecar JSON.
6. Priehľadné plátno Excalidrawu nad vlastným pozadím (bodky, štvorčeky) a jeho správanie pri zoome a posune.
7. Dá sa z API Excalidrawu zistiť, ktoré ťahy leží pod daným ťahom (na škrtanie), a ako rozpoznať škrtanie z pointer udalostí.

**M1 – Plátno**
Ribbon ikona „Nový zošit" a položka v menu priečinka, ktorá vytvorí `.zosit` a otvorí ho. Pero kreslí, prsty posúvajú a približujú, pôvodný horný panel Excalidrawu, výber pozadia (prázdne, štvorčeky, bodky), zmazanie preškrtnutím, ukladanie.

**M2 – PDF**
Otvorenie PDF, lazy render, scroll a zoom, indikátor strany a skok, kreslenie perom, guma, zmazanie preškrtnutím, späť/vpred, sidecar. Panel nástrojov v tomto režime vizuálne zladiť s Excalidrawom.

**M3 – Doladenie**
Odmietanie dlane, výkon, miniatúry strán, export PDF s poznámkami, limity zoomu, tmavá téma.

## 6. Akceptačné kritériá

- Na iPade sa dá vytvoriť zošit a kresliť bez jediného príkazu z palety.
- Pri kreslení perom sa dá kedykoľvek približovať dvoma prstami a posúvať jedným, bez prepínania nástroja.
- Plátno pri zoome neseká na veľkej mape (~500 ťahov a ~20 obrázkov).
- 300-stranové PDF sa otvorí do pár sekúnd a scrolluje plynulo, pamäť nerastie s počtom strán.
- Skok na ľubovoľnú stranu do 1 s.
- Po zavretí a znovuotvorení Obsidianu sú všetky ťahy na mieste.
- Súbory sa synchronizujú cez Remotely Save na druhé zariadenie a otvoria sa tam rovnako.
- Poriadne zaškrtnuté slovo sa zmaže, jedna alebo dve čiary cez text nič nezmažú. Obyčajné čmáranie bez textu pod ním ostane ako ťah.
- V režime plátna sa dá prepnúť pozadie na prázdne, štvorčeky a bodky. Raster sa pri zoome a posune hýbe spolu s plátnom a voľba ostane po znovuotvorení.
- Horný panel nástrojov Excalidrawu je v režime plátna nezmenený.

## 7. Praktické poznámky pre vývoj

- TypeScript, esbuild, šablóna `obsidian-sample-plugin`.
- Nasadenie na iPad: `.obsidian` sa cez Remotely Save pravdepodobne nesynchronizuje. Použiť plugin BRAT (súkromný GitHub repozitár) alebo skopírovať `main.js`, `manifest.json`, `styles.css` do `.obsidian/plugins/<id>/` cez appku Súbory. **[overiť]**
- Pridať jednoduchý ladiaci panel v pluguine (posledné pointer udalosti a chyby), lebo na iPade nie sú vývojárske nástroje po ruke.
- Meniť po malých krokoch a po každom milníku nechať užívateľa otestovať na iPade.

## 8. Prvý prompt pre Claude Code

> Prečítaj `plan-obsidian-zosit.md`. Začni milníkom M0 (spike). Vytvor kostru Obsidian pluginu z `obsidian-sample-plugin` s `isDesktopOnly: false` a postupne over všetky body z M0. Pre každý bod napíš, či predpoklad platí, a čo to znamená pre architektúru. Nepíš M1 ani M2, kým neodpoviem na výsledok spike. Pýtaj sa, ak nie je jasné, ako sa dá plugin dostať na iPad.
