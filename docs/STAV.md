# GoodNodes: stav k 9. 10. 2026 (verzia 0.5.0)

## Výsledky spike M0

| # | Predpoklad | Výsledok | Čo to znamená |
|---|---|---|---|
| 1 | Komponent Excalidraw beží v Obsidiane | ✅ Mac (Obsidian 1.14.4). iPad treba overiť, ale plugin Excalidraw na iPade beží, takže riziko je nízke | Komponent `@excalidraw/excalidraw` 0.18 v našom vlastnom zobrazení |
| 2 | `pointerType` rozlišuje pero a prst | ⏳ iPad. Logika je hotová a ladiaci panel ukazuje `pen`/`touch` | Ak by iPad hlásil pero ako `touch`, rozhodne `touchType === "stylus"` |
| 3 | Plynulý pinch cez `updateScene` | ✅ Mac: 500 ťahov, medián snímky 7 ms, 90 % pod 18 ms. iPad treba overiť | Excalidraw pen mode pri pere zoom nepustí, preto máme vlastnú vrstvu gest |
| 4 | pdf.js z Obsidianu, 300 strán | ✅ pdf.js 5.3.34 cez `loadPdfJs()`. Prvá strana za 120–130 ms, skok na stranu 250 za 14 ms, naraz najviac 5–6 canvasov | Lazy render funguje, pamäť nerastie s počtom strán |
| 5 | Remotely Save synchronizuje `.goodnodes` a `.pdf.goodnodes.json` | ⏳ iPad + Nextcloud | Sú to obyčajné textové súbory vo vaulte |
| 6 | Priehľadné plátno Excalidrawu nad vlastným pozadím | ✅ `viewBackgroundColor: "transparent"`, raster sa kreslí v našej vrstve podľa `onScrollChange` | Bodky aj štvorčeky sa hýbu a škálujú s plátnom |
| 7 | Škrtanie cez API Excalidrawu | ✅ `getSceneElements()` a `updateScene()`. Jeden krok späť funguje vďaka `CaptureUpdateAction.NEVER` pre škrtanie a `IMMEDIATELY` pre zmazanie | Rovnaký algoritmus (`src/scratch/detect.ts`) používajú obidva režimy |

## Hotové

**Plátno (M1):** vytvorenie z ribbonu aj z menu priečinka, pero ako predvolený nástroj, prsty posúvajú a približujú (aj s perom v ruke), klepnutie prstom na panel funguje, odmietanie dlane, pozadie (prázdne, štvorčeky, bodky, S/M/L) uložené v súbore, preškrtnutie, obrázky ako súbory vo vaulte, opätovné načítanie po synchronizácii, zapamätanie pozície a zoomu, svetlá a tmavá téma, fonty v pluginu (funguje offline).

**PDF zošit (M2):** lazy render, pinch zoom, pero, zvýrazňovač, guma, 6 farieb a 3 hrúbky, späť a vpred (tlačidlá aj Cmd+Z), preškrtnutie, indikátor a skok na stranu, obsah PDF, miniatúry, pamätanie poslednej strany, sidecar súbor `<pdf>.goodnodes.json`, export „PDF s poznámkami“ (pdf-lib), prispôsobenie šírke pri otočení iPadu.

**0.2.0 (po prvom teste na iPade):**
- Nastavenie pera sa otvára klepnutím na už vybraté pero, v plátne aj v PDF. Farba a hrúbka sa pamätajú. Ľavý panel Excalidrawu sa pri pere nezobrazuje.
- PDF v štýle GoodNotes: zjednodušený panel nástrojov, ľavý panel so záložkami Strany / Obsah / Záložky, záložky strán, posuvník, ktorým sa dá ťahať po stranách, a menu „…“ (zoom, prejsť na stranu, export).

**0.3.0:**
- Knižnica GoodNodes (📚): domovská obrazovka s obálkami zošitov a PDF, hľadaním, tlačidlami „+ New notebook“ a „Import PDF“ (z appky Súbory). V menu priečinka pribudlo „Import PDF here“.
- Plátno už nemá prvky Excalidrawu: vlastné hlavné menu, vlastný pomocník (aj pod „?“), knižnica bez odkazov na Excalidraw, ktorú zdieľajú všetky zošity, a žiadne AI ani Mermaid.

**0.4.0:**
- Knižnica (domovská obrazovka) je preč, všetko ide cez menu priečinka v Obsidiane: New GoodNodes notebook, New GoodNodes whiteboard, New text document a Import into GoodNodes here (PDF aj obrázky).
- Zošity: obálka, papier (prázdny, linajky, husté linajky, štvorčeky, bodky), A4 alebo Letter, na výšku alebo na šírku. Pridávanie, vkladanie a mazanie strán, vloženie strán iného PDF do zošita.
- Whiteboard: Insert PDF vloží strany PDF ako obrázky.

**0.4.2:**
- PDF z GoodNotes (aj s poznámkami) sa vykresľuje celé, rovnako ako v Preview. pdf.js teraz dostáva rovnaké doplnky ako vstavaný prehliadač Obsidianu (dekodér JPEG 2000, CMapy, štandardné fonty, ICC). Bez nich ostali obrázky strán biele.
- Strany sa listujú vodorovne ako v knihe a pri prispôsobenej veľkosti zaskočia na celú ďalšiu stranu. Pri priblížení sa zaskakovanie vypne a dá sa voľne posúvať. Zvislé posúvanie sa dá zapnúť v nastaveniach („Page turning“). Šípky, PageUp/PageDown a koliesko myši otáčajú strany.
- Bočný panel so stranami na širokej obrazovke (od 900 px) strany nezakrýva, ale odsunie ich doprava.
- iPad: farby a hrúbky v nastavení pera sú vidieť a dajú sa vybrať. Pravidlo Obsidianu `.is-tablet button:not(.clickable-icon)` prebíjalo náš reset okrajov tlačidiel z 0.4.1.
- Späť a vpred sú v hlavnom paneli nástrojov, už neprekrývajú stranu. Pri vodorovnom listovaní je vidno len aktuálnu stranu.
- Okno nového zošita: A4/Letter a Portrait/Landscape sú segmentový prepínač ako v iOS (predtým sa prekrývali), farby obálky sú kruhy.
- Obrazovka „New tab“ na iPade: tlačidlá sú opäť vycentrované. Obsidian obmedzoval ich kontajner na 280 px.

**0.4.3:**
- Pri listovaní ako v knihe je najmenší zoom celá strana a PDF sa vždy otvorí na celú výšku. Strany sa už nezoradia vedľa seba.
- Zoom (pinch aj menu) nepreblikáva: strana ostane viditeľná, kým sa ostrá verzia nevykreslí na pozadí.
- Bočný panel odsúva strany aj na iPade na výšku (užší, jeden stĺpec miniatúr). Panel nástrojov a číslo strany sa vycentrujú vo zvyšnom priestore. Ako prekrytie ostáva len na úzkych obrazovkách (pod 600 px).

**0.5.0 (nástroje ako GoodNotes, jeden toolbar všade):**
- Spoločný toolbar pre PDF, zošity aj whiteboard v jednom riadku: laso, pero, zvýrazňovač, guma, text, tvary, obrázok. Hneď vedľa sú voľby aktívneho nástroja (druhý riadok GoodNotes): typ pera, 3 hrúbky, 3 základné farby a 2 vlastné (vybratú vlastnú zmeníš ďalším klepnutím). Na konci späť, vpred a „…“. Keď sa nezmestí (na výšku, s bočným panelom), voľby idú do druhého riadku. Na whiteboarde nahrádza panel Excalidrawu; knižnica, papier, Insert PDF a „Draw with finger“ sú v „…“.
- Typy pera: plniace, guľôčkové, štetec. Draw and hold: nakreslený kruh, čiara, obdĺžnik alebo trojuholník sa po podržaní pera zarovná na dokonalý tvar (v PDF aj na whiteboarde, späť ho zmaže jedným krokom).
- Laso: v PDF vlastné (presun, zväčšenie za rohy, vystrihnúť, kopírovať, vložiť, zmazať, farba, duplikovať, späť); na whiteboarde označí prvky a ďalej ich ovláda Excalidraw.
- Guma v PDF: presná alebo celý ťah, „len zvýrazňovač“. Na whiteboarde maže celé prvky.
- Zvýrazňovač aj na whiteboarde.
- Text v PDF: klepnutie vytvorí textové pole, potiahnutie určí šírku a veľkosť písma (výška = jeden riadok). Klepnutím na existujúci text ho upravíš. Veľkosť S/M/L/XL, písmo, zarovnanie a farba platia aj pre práve písaný text (spoločné nastavenia s whiteboardom).
- Tvary v PDF: čiara, šípka, obdĺžnik, elipsa, kosoštvorec ťahaním. Sú to obyčajné ťahy, takže ich laso, guma aj späť berú ako ťah.
- Obrázok v PDF: vyberieš fotku, uloží sa do vaultu (priečinok obrázkov alebo príloh) a vloží sa doprostred strany, hneď označená lasom na presun a zväčšenie.
- Text a obrázky sa označujú lasom (stred musí byť v slučke), guma ani preškrtnutie ich nemažú. Export „PDF s poznámkami“ ich obsahuje (text ako obrázok v rozlíšení 4×, správne aj na otočených stranách).
- Posuvník strán je pri listovaní do strán vodorovný dole.
- Odstránené „New text document“ (Obsidian poznámky už má).

**0.4.4 (kontrola UI na iPade):** automatická kontrola všetkých obrazoviek, menu a dialógov v emulácii iPadu (na šírku aj na výšku): stlačené alebo prázdne tlačidlá, pretekajúci text, prekrývanie.
- Opravené: tlačidlá Excalidrawu na whiteboarde (hlavné menu, More tools, zoom −/+, späť/vpred, pomocník) boli na iPade prázdne, rovnaký problém s okrajmi tlačidiel ako pri pere v 0.4.2.
- Na výšku (mobilné rozloženie Excalidrawu) sa pri pere a texte skrýva tlačidlo „Edit“ v spodnej lište, rovnako ako ľavý panel na šírku.
- Ukážky hrúbky pera v PDF sú rozlíšiteľné (najtenšia bola neviditeľná). Prepínač „Draw with finger“ už nepretŕča.

**0.4.4 (PDF):**
- Pri priblíženej strane v režime knihy: keď stranu potiahneš ďalej za jej okraj, preskočí na susednú stranu, zarovnanú na príslušný okraj, so zachovaným zoomom a výškou. Krátke potiahnutie stranu vráti na jej okraj (strana neostane napoly s medzerou).

**0.4.4 (whiteboard):**
- Prst funguje aj bez Apple Pencil. V automatickom režime prst kreslí, vyberá a píše, kým v danom spustení Obsidianu nepoužiješ ceruzku. Potom prst posúva a približuje. Nastavenie „Draw with finger“ (Automatic / Always / Never) a rýchly prepínač v menu pera.
- Text má vlastné menu ako pero: klepni na už vybratý nástroj Text. Obsahuje farbu, veľkosť S/M/L/XL, písmo (Hand-drawn / Normal / Code) a zarovnanie. Ľavý panel Excalidrawu sa pri texte nezobrazuje. Text si pamätá vlastné nastavenia, oddelene od pera. Pri existujúcom texte sa z menu mení len farba, lebo Excalidraw 0.18 nevie text verejne premerať.
- Potiahnutie nástrojom Text vytvorí textové pole: výška obdĺžnika určí veľkosť písma (jeden riadok ho vyplní) a šírka zalamovanie. Editor sa otvára priamo pri dotyku, aby iOS ukázal klávesnicu.

**M3 a ostatné:** nastavenia (pero, citlivosť škrtania, dlaň, priečinok obrázkov, „otvárať PDF v GoodNodes“), ladiací panel, README, licencia MIT, verejný repozitár a automatické vydania (GitHub Actions) pre BRAT.

## Neotestované (len na iPade)

Všetko okolo Apple Pencil a dotykov v reálnom WKWebView: rozlíšenie pera a prsta, dlaň, plynulosť, gestá Obsidianu (otváranie bočného panelu), synchronizácia. Postup je v [TESTOVANIE-IPAD.md](TESTOVANIE-IPAD.md).

## Známe obmedzenia a ďalšie kroky

- Pinch na plátne prekresľuje scénu v každom snímku. Ak bude na iPade sekať, ďalší krok je počas gesta posúvať plátno cez CSS transformáciu a prekresliť ho až po pustení, rovnako ako v PDF.
- Prahy škrtania (4 zmeny smeru, 60 % pokrytia) treba doladiť na tvojom reálnom rukopise.
- V PDF sa zatiaľ nedá vybrať a presúvať ťahy (lasso) a nedá sa písať text. Podľa plánu sú to veci na neskôr.
- Oficiálny obchod Obsidianu: až bude verzia stabilná, pošleme PR do `obsidianmd/obsidian-releases`.
