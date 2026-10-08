# GoodNodes: stav k 8. 10. 2026 (verzia 0.1.1)

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

**M3 a ostatné:** nastavenia (pero, citlivosť škrtania, dlaň, priečinok obrázkov, „otvárať PDF v GoodNodes“), ladiací panel, README, licencia MIT, verejný repozitár a automatické vydania (GitHub Actions) pre BRAT.

## Neotestované (len na iPade)

Všetko okolo Apple Pencil a dotykov v reálnom WKWebView: rozlíšenie pera a prsta, dlaň, plynulosť, gestá Obsidianu (otváranie bočného panelu), synchronizácia. Postup je v [TESTOVANIE-IPAD.md](TESTOVANIE-IPAD.md).

## Známe obmedzenia a ďalšie kroky

- Pinch na plátne prekresľuje scénu v každom snímku. Ak bude na iPade sekať, ďalší krok je počas gesta posúvať plátno cez CSS transformáciu a prekresliť ho až po pustení, rovnako ako v PDF.
- Prahy škrtania (4 zmeny smeru, 60 % pokrytia) treba doladiť na tvojom reálnom rukopise.
- V PDF sa zatiaľ nedá vybrať a presúvať ťahy (lasso) a nedá sa písať text. Podľa plánu sú to veci na neskôr.
- Oficiálny obchod Obsidianu: až bude verzia stabilná, pošleme PR do `obsidianmd/obsidian-releases`.
