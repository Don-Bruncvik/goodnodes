# GoodNodes: stav k 9. 10. 2026 (verzia 0.4.3)

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

**M3 a ostatné:** nastavenia (pero, citlivosť škrtania, dlaň, priečinok obrázkov, „otvárať PDF v GoodNodes“), ladiací panel, README, licencia MIT, verejný repozitár a automatické vydania (GitHub Actions) pre BRAT.

## Neotestované (len na iPade)

Všetko okolo Apple Pencil a dotykov v reálnom WKWebView: rozlíšenie pera a prsta, dlaň, plynulosť, gestá Obsidianu (otváranie bočného panelu), synchronizácia. Postup je v [TESTOVANIE-IPAD.md](TESTOVANIE-IPAD.md).

## Známe obmedzenia a ďalšie kroky

- Pinch na plátne prekresľuje scénu v každom snímku. Ak bude na iPade sekať, ďalší krok je počas gesta posúvať plátno cez CSS transformáciu a prekresliť ho až po pustení, rovnako ako v PDF.
- Prahy škrtania (4 zmeny smeru, 60 % pokrytia) treba doladiť na tvojom reálnom rukopise.
- V PDF sa zatiaľ nedá vybrať a presúvať ťahy (lasso) a nedá sa písať text. Podľa plánu sú to veci na neskôr.
- Oficiálny obchod Obsidianu: až bude verzia stabilná, pošleme PR do `obsidianmd/obsidian-releases`.
