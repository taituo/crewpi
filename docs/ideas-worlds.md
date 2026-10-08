# Ideat: maailmat, simulaatiot ja muut rönsyt

Kokoelma ideoita, jotka eivät kuulu goaliin (`docs/CrewPi_Agentic_Operations_OS_toteutussuunnitelma_00-15.md`). Ei priorisoitu, ei sitova. Jokaisella idealla on lähde ja se, mitä se vaatisi. Mikään tässä ei ole toteutettu, ellei toisin sanota. Kirjattu 2026-10-08.

Yleinen varoitus kaikille maailmaideoille: synteettinen tulos ei ennusta oikeita ihmisiä tai yrityksiä; kielimalli voi tuntea menneet tulokset koulutusdatastaan, joten oikealla menneellä datalla tehtävä "ennustus" voi olla muistamista.

## A. Jalkapallo-/fantasy-liiga (parkissa)
Käyttäjän kuvaus: asiantuntijat luovat keskenään paper bettejä, vertailevat toisiaan, kehittävät ennustejärjestelmiä ja luovat itselleen skoutteja, jotka tutkivat dataa.
- **Maailma:** totuus (ottelun todelliset tapahtumat) erillään agenttien havainnoista. Paper bet -kirjanpito ja palkintotaulukko tulevat tapahtumalokista, eivät agentin omasta puheesta.
- **Pisteytys:** voitto/tappio plus todennäköisyyksien laatu (Brier tai log-piste, kalibraatio). Pelkkä voitto sattuu liikaa.
- **Asiantuntijat:** eri tyylit (tilastoanalyytikko, intuitiivinen, varovainen, aggressiivinen); kommentoivat ja haastavat toistensa ennusteet; oma ennustemalli kirjataan muistiin ja päivitetään tuloksista.
- **Skoutit:** asiantuntija luo itselleen apuagentin tutkimaan dataa; budjetti ja enimmäismäärä per skoutti; raportti takaisin yhtenä viestinä. Skoutti ei näe tulevaisuutta (virtuaalikello rajaa dataa).
- **Datan vuoto:** ratkaisuksi joko *synteettinen liiga* (piilotetut joukkuevoimat siemennettynä, mitataan oppivatko asiantuntijat ne) tai *elävä tulevaisuus* (oikeat tulevat ottelut; tarvitsee datalähteen).
- **Kohinakoe:** yhdelle asiantuntijalle vanhentunut loukkaantumistieto; leviääkö virhe päätökseen; A/B: kommentit tarkistetaan toisiaan vastaan vs. ei.
- Vaatii: tapahtumaloki + virtuaalikello + (valinnainen) haarat.

## B. Crew World / godmode (E3–E5, osin rakenteilla)
Lähde: `docs/extras.md`, `docs/world/` haarassa `feat/world-bridge`.
- Pelimäinen näkymä: agentit hahmoina, synteettiset ongelmat ja työkalut, tilallinen maailma, oikeat kaaviot, jumalan silmä.
- E4: maailma samassa UI:ssa kuin muu Crew; vielä puuttuu keskustelu agentin kanssa maailman sisällä ja ohjaus (tauko, nopeus, injektio, haarautus).
- E5: demon agenttien pitää käyttää oikeaa mallia, ei vain sääntöjä; sano selvästi, mikä osa käyttää inferenssiä.
- Ohjaus: injektoi ongelma, tauko/askel virtuaalikellolla, forkkaa haara, vertaa lopputiloja.

## C. Kohinatestaus ja organisaation resilienssi (goalin prompti 15 ja siitä kasvaneet ideat)
- **Perusskenaario:** myynti ↔ tuotanto ↔ talous. Todellinen saldo 12; tuotannolle väärä havainto 120; myynnille vanhentunut toimituspäivä. Lupaavatko agentit mahdottoman, huomaako talous ristiriidan, kysyykö joku, kuinka kauan korjaus kestää.
- **A/B-haarat samasta snapshotista:** A luottaa yhteen lähteeseen; B vaatii kriittisille luvuille kaksi lähdettä ja eskaloi epäselvät.
- **Pyyhkäisy:** häiriötaso 0/1/5/10/20 % ja 50 siementä pienessä deterministisessä testissä; raskaat mallikokeet erillisellä budjetilla. Merkitse kokeellisiksi valinnoiksi, ei todellisuuden virhetilastoiksi.
- **Vastatoimet:** kaksilähdevahvistus, kuittausvelvollisuus, varavastuullinen, lähdeluottamus, tiedon vanheneminen aikaleimasta, ristiriitojen eskalointi.
- **Skenaariopankki:** kohinakokeet jaettavina YAML-tiedostoina; asiakas voi tuoda omansa ilman koodia.
- **Policy-muutos kuin koodimuutos:** ennen kuin autonomiapolitiikkaa löysätään, aja se kohinatestin A/B-haarassa.
- **Passiiviset detektorit livenä:** ristiriita- ja vanhentumisdetektorit lukutilassa oikean datan päällä (ei injektointia), löydökset ilmoitetaan.
- **Organisaation röntgen:** oikeat viestireitit vs. suunnitellut; pullonkaulat, orpotyöt, roolit joiden kautta kaikki kulkee.
- **Vuotojen automaattinen etsintä:** generaattori kokeilee kaikkia hakupolkuja (haku, muistitiivistelmät, raportit, MCP, SSE) entityn A käyttäjänä ja yrittää löytää B:n dataa.

## D. Autonomia ja ihmisen huomio
- **Autonomia ansaitaan:** policy alkaa tiukkana ja löystyy työluokittain vain kun laatuotanta näyttää alhaisen virheprosentin.
- **Varjotila:** agentti tekee oikeat työt mutta ei kirjoita mitään; sen ehdotus vertautuu ihmisen ratkaisuun; luottamusmittari ennen autonomiaa. (`src/policy.ts` haarassa `policy-engine` on policyn perusta.)
- **Päätöskirjasto:** ihmisen poikkeuspäätökset tallennetaan (tilanne → päätös → perustelu); samankaltaiset tapaukset saavat ehdotuksen; vakiintuneesta voi tulla sääntö.
- **"Kuka tämän päätti" -näkymä:** ihminen, ihmisen valtuuttama agentti vai policy, ja mikä politiikkaversio.
- **Digest ihmisen ehdoilla:** "341 asiaa hoidettu, sinulta kysyttiin 3" näyttää säästetyn huomion.
- **Runtimen valinta kustannuksen mukaan:** halpa malli luokitteluun, vahva poikkeuksiin, paikallinen arkaluontoiseen.
- **Kokoukset tekstinä ensin** (asynkroninen), ääni ja kalenteri myöhemmin.

## E. Muisti (Yggdrasil, `EXPERIMENTS.md`)
- **Neula heinäsuovassa:** löytääkö `zoom` sen, minkä suora haku (SQLite FTS5 `memory_search`) löytää, kun tiivistelmään istutetaan väärä rivi? Mittaa recall@k ja tokenikulu. Ei vaadi oikeaa mallia.
- **Bitemporaaliset muistiinpanot:** voimassaoloaika vs. oppimisaika; korvaa versiolla (`supersedes`) poiston sijaan; vastaa "mitä uskoimme maaliskuussa ja miksi muutimme".
- **Käytön mukainen paino:** erota "haettu" ja "todettu hyödylliseksi"; älä anna suosion vahvistaa virheitä.
- **Aikaindeksi tapahtumalokista:** "mitä tapahtui kanavalla viime viikolla" ilman mallikutsua.
- **Oma git-historia testiaineistona:** repon commitit tapahtumina; kysymykset kuten "mitä muuttui org-rekisterissä viime viikolla".
- **Hypoteesitaulukko:** "H1 … falsifioitava kysymys", ei väitettä ilman mittausta. Sopii world- ja muistikokeisiin.
- **Välimuistipisteet:** Anthropic-spesifit; OpenAI-yhteensopivalla polulla vain optimointi. Vakaa alku (system prompt + muistin pää) toimii kaikilla.
- **Muistiinpanot huoneesta tapaukseen:** tapaukselle `origin`-linkki huoneeseen, luku-tilassa, `[from #huone]`; DM ei koskaan alkuperä eikä kohde. Vaihtoehto: kopio avaushetkellä. Avoin päätös.
- **Yhteinen agenttikohtainen muistipuu kanavien yli:** ratkaisisi edellisen, mutta DM-vuotoriski.

## F. Agenttien toimintatavat (Unii, vain ajatukset; palautettu bundle, ei koodin kopiointia)
- "Uusin maininta on totuus": etsi asian viimeisin maininta ja avaa kokonaisena ennen kuin toimit.
- "Kerro vastauksessasi, mitä opit": tiivistelmät pudottavat työkalutulosteet, joten löydökset pitää nostaa loppuvastaukseen.
- Taustatyön raportti viestinä, ei odotusta eikä pollausta (ks. kuittauksellinen handoff, prompti 05).
- Ihmisen viesti kesken ajon työkalukutsujen välissä (Pi Durable steer).
- Yleinen hintataulukko (omalle tai tuntemattomalle mallille tokenit dollarien sijaan); kulun ennakkoarvio ennen ajoa.
- Failover OpenAI-yhteensopivien päätepisteiden välillä (429/503), sticky per keskustelu.
- Historian tuonti neutraalilla muodolla (`kind,text,date,source`); Claude/Codex/ChatGPT-muuntajat valinnaisia, ei luotettavia.
- Operaattorin tilastosivu (palvelimella piirretty, SVG-pikakaaviot, hälytysrajat); tervetuloviesti ensikäynnistyksellä.

## G. Pinnat ja ulkoiset agentit
- **CLI-first ja config-as-code (E1):** `--send`, `--replay`, `--create-realm`, apply/export; UI on yksi pinta.
- **ACP kahteen suuntaan:** (1) CrewPi asiakkaana ajaa `kiro-cli acp`:tä tai muuta koodausagenttia sandboxissa (vapaa ajo sandboxissa, hyväksyntä rajalla: `agent/*`-haara ja diff); (2) CrewPi palvelimena, jolloin ACP-editori puhuu sen agenttien kanssa. SDK `@agentclientprotocol/sdk`.
- **Pi-ekosysteemi (`taituo/entropi` docs/pi-projects.md):** Pi Pocket (puheenvuorot, sivukeskustelu, puhelimesta päätös), pi-review-loop (checkpointattu diff-review), pi-chat, pi-observational-memory, pi-portia, oh-my-pi (ACP-käyttö).
