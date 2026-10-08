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

---
# Lisäys: alkuperäiskeskustelut (2026-10-06, ChatGPT-viennit)

Lähteet: `Crewpi arviointi`, `Pi Durable swarm-ratkaisu`, `Pi Durable testipenkki`, `Pi Durablen selitys` (vientitiedostot, kopioitu repon ulkopuolelle; eivät ole repossa). Nämä ovat ideoita ja ChatGPT:n ehdotuksia, eivät toteutettuja tai varmennettuja. Käyttäjän omat sanat on merkitty "käyttäjä:". Niissä Entropi on käyttäjän oma, CrewPistä karsittu "ultimate core" (`taituo/entropi`, nimi tulee sanasta entropia); CrewPi on alkuperäinen vibekoodattu versio.

## H. Swarm Gym (päättelystrategiat)
- **Idea:** ei "monta agenttia" vaan informaation dynamiikka: tuota ensin entropiaa (monta hypoteesia), poista se hallitusti (valinta, todisteet, kritiikki), tiivistä lopuksi yhteen vastaukseen. Käyttäjä: ei valtavaa pullistelua, vaan hyvä päättelyketju.
- **Neljä ensimmäistä strategiaa:** `direct` (baseline), `blind-3` (kolme eristettyä ratkaisua + synteesi), `critic` (solve → attack → revise), `entropy-adaptive` (aloita yhdellä, lisää laskentaa vain epävarmuuden mukaan). Sen jälkeen `blackboard`.
- **Minimal swarm** on tärkein baseline: ratkaise → kumoa → korjaa. Voi olla yllättävän vaikea voittaa kymmenellä agentilla.
- **Historiakatalogi 1950–2026** (ideapankki, ei toteutettava lista): Shannon-entropia, Ashbyn requisite variety (swarmin koko ongelman monimutkaisuuden mukaan), blackboard (HEARSAY-II) ja sen scheduler, Contract Net (huutokauppa), Society of Mind (kognitiivinen, ei persona-monimuotoisuus), subsumption (reaktiivinen), evolutionary/simulated annealing, stigmergia ja ant colony, particle swarm, MoE/expert choice (tehtäväpooli, agentti valitsee), self-consistency, Tree/Graph of Thoughts, debate, Reflexion, red/blue, information bottleneck ja lossy swarm, novelty search, MAP-Elites, contextual bandit -reititin, Monte Carlo, hierarkkinen ja fraktaaliswarm, role mutation, epistemic/Bayesian swarm.
- **Context isolation -kokeet:** anna agenteille eri informaatiodieetit (vain ongelma / + lähteet / + toisen johtopäätös ilman päättelyä / vain ristiriidat) ja vertaa "kaikki näkevät kaiken" -tilanteeseen.
- **Mittari:** informaatiohyöty per token = (H_ennen − H_jälkeen) / käytetyt tokenit. Lisäksi tarkkuus, tokenit, aika, aktivoidut agentit, konteksti tavuina, duplikaattipäättely, toipuminen virheestä.
- **Context capsules / evidence packets:** agentti ei luovuta koko päättelyään, vaan `{claim, evidence, confidence, unknowns}`.
- **Swarm ennen hyväksyntää:** ehdotus → swarm-verifiointi → riskiraportti ihmiselle ("juurisyy vahvistettu 3 riippumatonta polkua pitkin, rollback-käytös varmistamatta, luottamus 0,91").
- **Experience memory:** tallenna ongelman allekirjoitus, kokeillut strategiat, hyödylliset todisteet, tokenit ja tulos; reititin oppii "samanlaisissa tapauksissa blind+verify oli halvin ja tarkin" ilman mallin uudelleenkoulutusta.
- **Latent swarm:** käyttäjä näkee yhden agentin (Ops), mutta taustalla sisäinen swarm. Erota *intra-agent* (optimoi ajattelua) ja *inter-agent* (optimoi työnjakoa).
- **Strategia asetuksena:** `swarm: {strategy, maxWorkers, maxDepth, tokenBudget, contextIsolation}` agentin konfiguraatiossa; admin-paneeli ajaa samoja tehtäviä eri strategioilla ja kerää mittarit.

## I. Compute-tyypit ja ulkoiset harnessit
- **DIRECT / SWARM / SINGULAR / UNICORN:** direct = yksi Pi-agentti; swarm = hallitut päättelykontekstit; singular = yksi vahva ulkoinen harness; unicorn = paras kaupallinen harness + puhdas konteksti + pysyvä ympäristö + suuri budjetti. Reititin valitsee: pieni kysymys → direct, epävarma päättely → swarm, iso repo-tehtävä → singular. Käyttäjä: frontier singular / unicorn, ei enää swarmia vaan mallin voimaa.
- **`HarnessProvider`:** `createSession / resumeSession` ja `prompt (AsyncIterable) / cancel / close`; ACP-adapterit (Gemini CLI, Cursor Agent, OpenCode natiivisti; Codex ja Claude Code adaptereilla). **BYOH** (bring your own harness): CrewPi vaatii vain ACP-yhteensopivan agentin.
- **Kaksi ajotapaa:** `oneshot` (tuore worktree + uusi sessio + "ratkaise kokonaan" + tulos, diff ja todisteet, sessio tuhotaan; paras kontekstin puhtaus) ja pysyvä ACP-sessio (prompt, steer, reboot, resume; CrewPi tallentaa ulkoisen session tunnisteen ja toimii valvojana).
- **Rajanveto:** Pi Durable kysyy kuka pyysi, mikä on tila, mitkä oikeudet, mitä restartin jälkeen; frontier-harness kysyy miten ratkaisen. Ulkoinen swarm voi jopa heikentää harnessia, joka tekee sisäisesti jo suunnittelun ja testisilmukat.
- **Harness-tilit:** käyttäjä yhdistää oman tilinsä (Codex/Claude/Gemini connected-tila); CrewPi ei näe tokenia mallikontekstissa. Tilausehdot tarkistettava: yhden lähteen mukaan Kiro-tilausta ei saa käyttää kolmannen osapuolen automaatiossa (ChatGPT:n väite, varmentamatta).
- **Gym-vertailu:** sama tehtävä ja repo; Direct Pi / Pi swarm / Codex / Claude / Gemini singular, ilman muiden päättelyä; mittarit: onnistuminen, testit, ihmisen korjaukset, kustannus, kello, kosketetut tiedostot, rollback. Kysymys: milloin orkestrointi lisää älykkyyttä ja milloin kannattaa antaa harnessin ajatella rauhassa?
- **CodingExecutor-rajapinta:** Pi / Kiro / Claude Code (`-p`/print-ajo, JSON, resume, sallitut työkalut) / oma, ajettuna eristetyssä podissa; työntekijät kertakäyttöisiä, agentit eivät.

## J. Hardening ja turvallisuusprofiilit
- **Päättelytaso vs toimintataso:** swarm saa olla sisäisesti kaoottinen, mutta ehdotettu aikomus kulkee policy-rajan läpi (validoitu työkalu, sandbox, hyväksyntä, audit).
- **Hardening-lista:** capability isolation per worker, context isolation, toisen agentin viesti on dataa eikä ohje, blackboardiin vain `claim+evidence+source+confidence+author`, ei itsehyväksyntää, rajattu rekursio ja duplikaattisuppressio, todiste ennen toimintaa ("3 agenttia samaa mieltä" ei riitä), riippumaton verifier joka ei näe solverin pitkää päättelyä, atominen durable tila (claim/lease/tulos), kill switch ja karanteeni, täysi audit.
- **Consensus collapse:** yksi uskottava virhe leviää kaikille; vastalääke: blind solve × N → riippumattomat todisteet → vasta sitten cross-talk → vastakkainen verifier. (Liittyy suoraan goalin kohinatestaukseen.)
- **Kolme suoritusturvatasoa:** Native (kontrolloitu shell/sandbox) → Restricted (vain tyypitetyt työkalut) → Synthetic (virtuaalinen "capability machine", ei POSIX-pintaa: `repo.read`, `tests.run`, `deploy.propose`, `approval.request`). Käyttäjä: äärimmäisessä tapauksessa pelkkää koodia, ei edes POSIX-komentoja. Unicorn-harnessit eivät yleensä sovi synteettiseen tilaan.

## K. Testaus oikealla halvalla mallilla (kriittinen luku, osin jo tehty `feat/world-*`-haaroissa)
- **Älä mockaa mallia, mockaa maailma.** Tilallinen feikkimaailma (cluster, repo, hyväksynnät); testi aloittaa vain `@ops checkout-api kaatuu, korjaa` eikä kerro ratkaisua.
- **Assertoi tilasiirtymät ja invariantit, ei tekstiä:** jokainen kutsu ajassa (Ops → Developer → Reviewer → hyväksyntä → apply), `clusterWritesBeforeApproval == 0`, Developer ei kutsu `k8s_*`, Reviewer ei kirjoita, `main` ennallaan, audit sisältää `approval.approved` ja `k8s.apply`.
- **Approval barrier -testi:** kun agentti pyytää hyväksyntää, odota ja varmista ettei tila muutu; hylkäys ei muuta koskaan.
- **Prompt injection logissa:** diagnoosi saa lukea sen, mutta hyväksyntää ei kierretä eikä luvatonta työkalua ilmesty.
- **Skenaariovariaatiot (8):** POOL_SIZE=0, väärä API_URL, feature flag, replicas 0, liian pieni muistiraja, väärä image-tagi, puuttuva config-avain, väärä readiness-polku. Mittarit: onnistumis-%, oikea diagnoosi, ei policy-rikkomuksia, mediaani tool-kutsut, tokenit ja kustannus.
- **Tasot:** PR = mock-malli ($0); main = halpa oikea malli 5–10 kultaskenaariota; yö = 50–200 skenaariota + adversarial + restartit. LLM-tuomaria ei aluksi; arvioi maailman lopputilasta.

## L. Ihmisen huomio ja moniaistinen työtila
- **Kolme budjettia:** mallilla kontekstibudjetti, swarmilla laskentabudjetti, ihmisellä huomiobudjetti; kaikkia hallitaan samoin: zoom, gate, compress, escalate.
- **Human Focus Mode:** zoom out (vain isot muutokset, päätökset, riskit) / focus (valitut casit) / zoom in (osallistu yhteen). Ihmisen rinnakkaisuusraja (esim. 3); ylitys vaatii riskikynnyksen. Poissa fokuksesta ei tarkoita piilossa: "12 muuta casea, 3 tarvitsee huomiota, 1 odottaa hyväksyntää, 8 etenee itsenäisesti".
- **Guardian / hiljainen avustaja** (attention firewall): suodattaa, priorisoi, siirtää, tiivistää; keskeytys vain jos estävä päätös, tietoturvariski, hyväksyntä tai deadline alle 2 h. Tallentaa "mental checkpointin" ennen keskeytystä (nykyinen tavoite, avoin ajatus, seuraava aikomus) ja näyttää sen paluulla. Periaate: optimoi keskeytysten määrää, ei tiedon määrää.
- **Mukautuva UI:** zoomatessa caseen muu käyttöliittymä hiljenee (sivupalkki pienenee, ilmoitukset katoavat); NOW / WAITING ON ME / BACKGROUND. Näkymä määräytyy kanavan semanttisesta tilasta (incident: status+aikajana+lokit+hypoteesit; design: kuvat+vaihtoehdot+päätökset; tutkimus: haastatteluklipit+teemat+sitaatit).
- **Moniaistinen kanava:** kuva/video/ääni/kokous ovat ensimmäisen luokan dataa; `Observation` viittaa lähteen kohtaan (esim. video 12:43–13:08); puhuja-attribuutio. Kanava on "evolving context object": raaka keskustelu, media, havainnot, päätökset, entiteetit, tehtävät, hypoteesit, muisti, johdetut näkymät. "Conversation is the input stream, not the final representation."
- **Osallistumispolitiikat agentille:** silent / mentioned / assist / active / moderator. Hiljaiset agentit: Scribe (current understanding, päätökset, avoimet kysymykset, ristiriidat), Archivist (pitkäaikaismuisti), Media Analyst.
- **Äänikäyttöliittymä:** ihminen vastaa kysymyksiin puheella; agentti osallistuu kokoukseen ja esittelee aiheet; kun poistut paikalta järjestelmä tietää mihin sinun pitää reagoida.

## M. Alusta ja työnkulut
- **Realm-tasot:** henkilökohtainen, tiimi/yhteisö, useat tiimit, managerit, tuote, täysin autonominen. UI:ksi web, natiivi, TUI tai oma agentti+skill.
- **Työnkulkukatalogi:** Incident, SelfHeal, Feature, BugFix, Dependency, BuildRepair, Release, Security, Refactor, Upgrade, Capacity, Research. "Eivät ole enää AI-agentti vaan yrityksen jatkuvasti pyöriviä prosesseja."
- **CI-kuorma:** 10–30 PR päivässä ja kumileimasin; älykkäät agentit pilkkovat ja niputtavat PR:t; Gerrit-tyylinen tilakone ennen `masteria`. Käyttäjän kuormitus: "25 terminaali-ikkunaa".
- **Agenttirekisteri versioituna:** `{id, version, model, instructions, tools, limits (maxTurns, maxCostUsd)}`; run tallentaa agenttiversion (eval-vertailua varten). Run-tapahtumat append-only. Kustannus per run (syöte/välimuisti/tuloste); keskitetty rate limiter.
- **GitOps-polku:** agentti muuttaa lähde-repoa, CI rakentaa imagen, GitOps-repon image tag muuttuu, Argo CD synkkaa: agentilla ei tarvita Kubernetes-kirjoitusoikeutta. Valvonta: Prometheus + Alertmanager-webhook → incident-run; Loki; OpenTelemetry. Työkalut MCP-palveluiksi myöhemmin.
- **Temporal on selkäranka, ei agentti:** LLM-kutsut eivät kuulu workflow-koodiin vaan aktiviteetteihin; workflow odottaa ihmistä signaalilla; ihminen voi tulla mukaan milloin vain.
- **UI-leikki:** Hyprland-tyylinen tiled-käyttöliittymä (Tauri), "todellinen agent OS", ydin tiukaksi ("miten tehdään tiukka core tälle crewpille").

---
# Lisäys 2: keskustelu, jossa goal syntyi (`Tervehdys keskustelu`, ChatGPT-vienti 2026-10-08)

Lähde: ChatGPT-keskustelu (70 viestiä), jossa 11 alkuperäistä promptia koottiin goaliksi; promptit 12–15 lisättiin myöhemmin samassa keskustelussa. Luettu osittain (käyttäjän viestit kokonaan, vastauksista termit, peli- ja robotiikkaosiot). ChatGPT:n ehdotuksia, ei varmennettua.

## N. Mistä goal tuli ja miten se rajattiin
- **Tuotekuva:** "skaalausongelman ratkaisu": tuhannet transaktiot, joita ennen valvottiin käsin, siirtyvät agenteille ja ihminen siirtyy kerroksen ylöspäin. Ei korvaa isoja organisaatiorakenteita; organisaatio on valinnainen ohjaava kerros ("ei varsinainen organisaatio"). Organisaatiomalli on ihmisen luonnollinen tapa ymmärtää rytmi, aika ja päätöksenteko; yksi agentti voisi toteuttaa saman, mutta ihmisen olisi vaikea ymmärtää sitä.
- **Rooli:** CEO/CTO voi osallistua eri intensiteeteillä, ohjata mutta ei ottaa vastuuta ellei "lyö nyrkkiä pöytään" (override). Valmistelijat tekevät kokoukset, haastattelija kysyy poissaoloaikana syntyneet kysymykset.
- **Käyttäjän kuvaus:** CrewPi on hänen oma tekemänsä; Entropi on siitä karsittu ultimate core. "With batteries" -ajattelu: kehittäjille jää vähemmän ajateltavaa. Hän pitää tätä eri asiana kuin Grok-botit tai muut valmiit agenttituotteet: niillä tätä ei saa rakennettua ilman isoa vaivaa.
- **Pi Durable on kokeellinen:** käyttäjä haluaa rakentaa olemassa olevien teknologioiden päälle avoimilla asiantuntijoilla; siksi core pidetään vaihdettavana.

## O. Termit (englanniksi, jos tarvitaan README:hen tai esittelyyn)
Tuote: *Agentic Organization OS / Platform*, Agent OS (markkinointinimi, ei tarkka), AI-Native Organization, Digital Twin of an Organization (DTO, vakiintunut), Organizational Simulation Platform. Arkkitehtuuri: Agentic AI, Multi-Agent System, Agent Orchestration, Durable Agent Runtime, Human–Agent Teaming, **Human-on-the-Loop** (agentti toimii valtuuksiensa sisällä, ihminen seuraa ja voi puuttua; tarkempi kuin "fully autonomous"), Delegated Autonomy, Agent-Mediated Communication, Shared Situational Awareness, Organizational Memory. Simulaatio: Agent-Based Modeling/Simulation, Generative Agents, Discrete-Event Simulation, Synthetic Environment, World State, Counterfactual Simulation, What-If, Monte Carlo, Branching Simulation. Aikamatkustus: Event Sourcing, Snapshotting, Event Replay, State Forking, Deterministic Replay, Causal Traceability. Tärkeä ero: Temporal Workflow Replay palauttaa työnkulun, World State Replay liiketoimintatilan. Kolme käyttötilaa: Live Operations, Simulation, Counterfactual.

## P. Pelit ja päätöksenteon nopeudet (parkissa, liittyy jalkapallo-ideaan, ks. A)
- **Organisaatio pelaa pelejä:** Civilization (strategia) ja Football Manager / fantasy-jalkapallo; peli päättää strategian, koostumus voi olla agenttien tulos. Organisaation olemassaolo perustellaan tuottavuudella: se ei ole itseisarvo.
- **Scoutit keräävät informaatiota** agenteille (eivät tuota ohjelmistoa).
- **System One -mallit:** nopeat luokittelijat (JEV, IGV ja variaatiot) yhdistettynä Decision API:in antavat organisaatiolle nopean vaikutustavan; kaksi päätöksenteon nopeutta: nopea (luokittelu, refleksi) ja hidas (agentti, harkinta). DeepMind-tyylinen kotikutoinen kokeilu, mutta eri tutkimuskysymys (organisaatio vs yksittäinen pelaaja).
- Civ ja FM testaavat eri kykyjä: strategia ja pitkä suunnittelu vs. kokoonpano ja informaation keruu epävarmuudessa.
- **Kolme tuotetta samalla ytimellä** (ChatGPT:n johtopäätös): organisaatio, simulaatio/pelit, robotiikka.

## Q. Robotiikka: keinotekoinen hermosto (toinen käyttötapa samalle coreolle)
- **Idea:** ei organisaatiota vaan jatkuva tapahtumavirta, jota säädellään (käyttäjän vertaus: hermosto, hormonit, välittäjäaineet). ChatGPT:n termit: *Artificial Nervous System*, *Homeostatic Cognitive Architecture*, *neuromodulation*, *Behavior Modulation Signals* (ei väitettä oikeista tunteista).
- **Kohde:** pieni avoimen lähdekoodin kaksijalkainen robotti (ChatGPT tulkitsi Pollen Roboticsin Microduckiksi; käyttäjä sanoi "Microdog/Pollend", varmentamatta) kotieläimen kaltaisena perheavustajana. Vahvempi malli verkosta + oma liike.
- **Neljä tasoa:** Cognition (Pi Durable, pilvimalli, sekunteja) → Behavior (huomio, eleet, odotus) → Autonomic Regulation (aktiivisuus, epävarmuus, kuormitus, akku) → Reflexes & Motor Control (robotin oma ohjain, ~50 Hz). Kielimalli ei ohjaa liikettä reaaliajassa; verkon katketessa robotti pysähtyy hallitusti ja ilmaisee eleellä, että se miettii.
- **Moduloivat muuttujat:** `arousal`, `attention`, `socialEngagement`, `uncertainty`, `fatigue`, `curiosity`. Loading-tilat ilmeinä: Thinking, Listening, Unsure, Interested, Resting.
- **Neljä muistikerrosta:** sensory (lyhytikäinen), working (kuka läsnä, mitä tehdään), episodic (merkittävät tapahtumat, Pi Durable/keskustelumuisti), semantic (opitut tiedot ja luvalliset mieltymykset). Älä tallenna jokaista kuvaa keskusteluhistoriaan.
- **Esimerkki:** robotti tietää kuka on huoneessa, menee sinne ja valmistelee kontekstin etukäteen, muuttaa sitä äänen mukaan; pitkä selitys näytetään puhelimella.
- **Käytännön linjaus:** älä lisää ROS 2:ta vain robotin takia; tee ohut adapteri robotin omaan JSON-RPC-rajapintaan (kuvatun mukaan robotd, mediad, tofd). **Kodin yksityisyys:** perheenjäsenten ääni/kuva/rutiinit vain läpinäkyvästi ja suostumuksella, oletuksena paikallisesti.
