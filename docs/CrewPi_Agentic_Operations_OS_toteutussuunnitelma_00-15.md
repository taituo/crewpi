# CrewPi → Agentic Operations OS & Organization Digital Twin
## Yhtenäinen toteutussuunnitelma ja 16 itsenäistä koodauspromptia (00–15)

**Versio:** 1.2 – organisatorisen resilienssin noise testing lisätty; aiempi päätavoite: suurivolyymisen työn delegointi agenteille, ihmisen poikkeusohjaus, Teams-edustaja ja Realm-federointi  
**Päiväys:** 8.10.2026  
**Lähtökoodi:** [taituo/crewpi](https://github.com/taituo/crewpi), `main` (tarkastuksessa SHA `873a01a30eeff381395841d986ad43d65bf6dcfb`)  
**Käyttötarkoitus:** annetaan koodausklientille vaiheittain; jokainen prompti on oma toteutettava työ.

**Päätavoite:** vapauttaa ihmisiä tuhansien toistuvien työ-, päätös- ja viestintätapahtumien käsin käsittelystä siirtämällä ne valtuutetuille agenteille. Ihminen siirtyy poikkeusten, laadun, strategian ja valvonnan tasolle. Alusta EI pyri korvaamaan asiakkaan olemassa olevaa organisaatiorakennetta; organisaatiomalli on valinnainen työnjako-, käyttöoikeus- ja näkymäkerros, joka voidaan yhdistää nykyisiin tiimeihin ja kanaviin. Myös yksi fyysinen agenttiruntime voi palvella montaa loogista roolia.

**Tuotevariantit:** (1) Teams-/Slack-edustaja nykyisen organisaation sisällä; (2) Agentic Operations -alusta useille agenteille ja prosesseille; (3) Business Realm -malli useille erillisille tai sisaryhtiö-entiteeteille; (4) erillinen synteettinen organisaatiosimulaattori ja digitaalinen kaksonen.

> **Tavoite:** Rakenna alustasta organisaation keskustelukäyttöliittymä, jossa ihmiset, heidän avustavat tekoälynsä, sisäiset agentit ja ulkoiset MCP-agentit voivat osallistua yhteiseen työhön. Organisaatio määrittää itse rakenteensa ja päätösvaltansa. Sama organisaatiomalli voidaan ajaa eristetyssä synteettisessä maailmassa, simuloida, pysäyttää, palauttaa tilannekuvaan ja haarauttaa vaihtoehtoisiksi aikajanoiksi. Ihmiset voivat liittyä mukaan organisaation omaan rytmiin kokousten, haastattelujen ja tilannekatsausten kautta.

## Tuoteperiaate: skaalaa työtä, älä lisää chat-kohinaa

**Työyksikkö (Work Item / Business Operation)** voi olla asiakasviesti, tiketistä tehty selvitys, laskun tarkistus, koodimuutos, julkaisu, poikkeamapäätös tai kahden tiimin välinen tiedonsiirto. Työyksikkö ei ole sama asia kuin SQL-transaktio. Se on seurattava liiketoimintatapahtuma, jolla on alkuperä, toimivaltuus, vastuullinen, suoritus, tulos ja tarvittaessa eskalointi.

1. **Default-to-delegation:** normaalit, matalariskiset tapahtumat käsitellään agenttipoolissa ennalta määriteltyjen sääntöjen sisällä.
2. **Exception-driven human oversight:** ihminen saa vain korkean vaikutuksen, epävarmat, epätavalliset tai valtuusrajan ylittävät kysymykset. Ei jatkuvaa hyväksyntäjonon mikromanagerointia.
3. **Human-native abstraction:** kokoukset, rytmit, keskustelut, raportit ja organisaatioroolit ovat ennen kaikkea ihmisen kognitiivinen käyttöliittymä; ne eivät vaadi 1:1 fyysisiä agenttiprosesseja.
4. **Existing-org-first:** mallinna nykyinen organisaatio tai pelkkä sen pieni osa; älä vaadi organisaatiokaavion tai työprosessien uusimista käyttöönoton ehtona.
5. **Channels as surfaces:** Teams, oma chat, MCP ja API ovat saman domain-toiminnan käyttöliittymiä, eivät itsenäisiä päätöstietokantoja.
6. **Realm as business federation:** `BusinessRealm` ryhmittelee erillisiä `Entity`-toimijoita (esim. sisaryhtiöitä, liiketoimintayksiköitä, asiakkaan yrityksiä, simulaatiota). Älä sekoita sitä Keycloakin identiteetti-`realm`-käsitteeseen.
7. **Measured autonomy:** seuraa läpimenoa, työjonon pituutta, ihmisen huomiokustannusta, virheitä, korjauskierroksia, turvallisuusrajoituksia ja agenttien kustannusta per valmistunut työyksikkö.
8. **Information robustness:** testaa tiedon puuttumista, vääristymistä, ristiriitoja ja virheellisten päätelmien leviämistä kontrolloidusti eristetyssä synteettisessä maailmassa; pidä todellinen tila aina erillään toimijoiden havainnoista.
9. **Truthful product state:** CrewPi:n nykyinen demo toimii rajatussa muodossa; tässä kuvatut skaalaus-, Teams-, Realm- ja simulaatio-ominaisuudet ovat toteutussuunnitelmia, eivät valmista tuotantoteknologiaa.

**Esimerkkikulku:** 10 000 saapuvaa työyksikköä → policy engine luokittelee ja valtuuttaa → Temporal-jonot ja workerit jakavat työkuorman → rajatut agentit suorittavat → tulokset tarkastetaan ja kirjataan → vain poikkeukset nostetaan ihmiselle → Teamsin tai chatin organisaatioedustaja raportoi olennaisen.

**Tämä on suunnittelu- ja toimeksiantodokumentti, ei väite siitä, että ominaisuudet olisi jo toteutettu tai testattu.** Jokaisen promptin alussa on velvoite tarkastaa repositorion senhetkinen tila. Näin dokumentti säilyy käyttökelpoisena, vaikka koodiin tulee muutoksia.

---

# A. Käyttöohje koodausklientille

1. Avaa CrewPi-repositorio koodausklientissä ja anna ensin **Prompti 00** kokonaan. Se tuottaa auditoidun suunnitelman, ei tee tuotantokoodin muutoksia.
2. Tarkista ehdotetut ADR-päätökset ja hyväksy työn rajaus. Tee sitten **yksi prompti kerrallaan** suositellussa järjestyksessä alla.
3. Aloita jokainen uusi vaihe tuoreesta repository-tilanteen tarkistuksesta; aikaisempi suunnitelma on ohje, ei oletus toteutuksen valmistumisesta.
4. Vaadi jokaisesta vaiheesta muutostiedostot, migraatiot, testit, lyhyt demo, rajaukset ja keskeneräiset asiat. Älä hyväksy pelkkää näyttävää käyttöliittymää, jonka API:t ovat feikkejä.
5. Säilytä demotila toimivana ja käsittele uudet ominaisuudet tarvittaessa feature flagien takana.

### Alustava työjärjestys – työn delegointi ensin, simulaatio erillisenä polkuna

| Järjestys | Prompti | Riippuvuus / syy |
|---|---|---|
| 1 | **00** Auditointi ja arkkitehtuuri | Todellinen lähtötilanne ja valtuudet |
| 2 | **04** Valinnainen organisaatiomalli | Roolit ja suhteet ilman pakotettua rakenneuudistusta |
| 3 | **13** Business Realm ja Entity-federointi | Erilliset entiteetit, tenant-rajaus, sisaryrityssuhteet |
| 4 | **05** Tapahtumat ja handoffit | Luotettava työyksikköjen ja päätösten perusta |
| 5 | **11** Suurivolyyminen työn delegointi | Policy routing, agenttipoolit, Temporal-työjonot |
| 6 | **14** Valvonta ja poikkeuskeskus | Ihmiselle vain olennaiset riskit ja tulokset |
| 7 | **01** Luonnollinen chat | Ihmisen ymmärrettävä näkymä yhteiseen toimintaan |
| 8 | **02** Ulkoiset agentit ja avustetut viestit | Provenienssi, identiteetti ja oikeudet |
| 9 | **03** MCP-rajapinta | Yhteisen domain-API:n turvallinen avaaminen |
| 10 | **12** Teams- ja kanavaedustaja | Ohut adapteri eikä rinnakkainen agenttiorganisaatio |
| 11 | **09** Ihmisen rytmi ja paluuhaastattelu | Katsaukset ja osallistumisen ajastus |
| 12 | **10** Kokoukset ja delegoitu valta | Yhteiset päätöskäytännöt |
| 13 | **06** Synteettinen maailma | Erillinen kehityspolku yhteisten domain-sopimusten pohjalta |
| 14 | **07** Snapshotit ja aikajanahaarat | Simulaation versioitu pysyvyys |
| 15 | **08** Simulaation stressitestit | Luotettavuuden ja organisaatiovalintojen tutkiminen |
| 16 | **15** Information Noise & Organizational Chaos Testing | Väärän tiedon leviäminen, korjauskyky, epävarmuuden hallinta; edellyttää 06–08 ja 07-haaroja |

**Vaiheistus ei ole pakollinen monoliitti:** promptit 06–08 ja 15 voidaan toteuttaa erillisessä palvelussa tai työhaarassa, kun yhteiset sopimukset on jäädytetty. Prompti 03 saa julkaista `simulation_*`-työkalut vasta, kun niitä vastaavat domain-palvelut todella ovat olemassa. Promptit 09–10 voivat saada ensimmäisen oikean maailman MVP:n ennen laajaa simulaatiointegraatiota, jos tämä päätetään Promptissa 00.

### Koodausklientille annettava lyhyt aloitusohje

```text
Lue dokumentti CrewPi_Agentic_Operations_OS_toteutussuunnitelma_00-15.md kokonaan.
Toteuta vain minulle nimetty PROMPTI, älä seuraavia vaiheita ennakkoon.
Noudata osioiden B–D yhteisiä arkkitehtuuri-, turvallisuus- ja hyväksymisvaatimuksia.
Tarkista nykyinen repositorio, dokumentoi suunnitellut rajapinnat, tee pienet yhteensopivat muutokset,
aja saatavilla olevat testit ja raportoi tosiasialliset tulokset.
Älä muuta tuotantoa, käytä ulkoisia integraatioita tai lisää oikeita sivuvaikutuksia ilman hyväksyttyä rajaa.
```

---

# B. Tarkistettu nykytila ja tavoitearkkitehtuuri

## B1. CrewPi:n todettu lähtötilanne

Kooditarkastuksessa nykyinen prototyyppi käyttää Node.js + TypeScript -palvelinta, Preact + htm -käyttöliittymää, SQLite-pohjaista workspace-tallennusta, `@earendil-works/pi-durable`-agenttiajoympäristöä, Pi AI -mallirajapintoja sekä Temporal-workflow'ta. Keskustelut jakautuvat pysyviin kanaviin, tapauskanaviin ja henkilökohtaisiin DM-keskusteluihin. Agentti vastaa tavallisesti vain, kun se mainitaan kanavalla; agentin oma keskusteluhistoria on per `(channel, agent)`.

Olemassa olevat mekanismit, joita kannattaa hyödyntää:

- `src/agents.ts`: nykyiset agenttien roolit, mallit, oikeudet ja ohjeet.
- `src/channels.ts`: kanavat, DM-näkyvyys, jäsenet ja @maininnat.
- `src/runtime.ts`: Pi Durable -keskustelut, mallivalinta, ajot ja tapahtumapeilaus.
- `src/tools.ts`: `ask_agent`, rajatut työkalut, hyväksynnät.
- `src/db.ts`: viestit, hyväksynnät, auditointi ja keskustelujen viittaukset.
- `src/memory.ts`, `src/optchat.ts`: muistiinpanot ja hierarkkinen keskustelumuisti.
- `src/temporal.ts`, `src/activities.ts`, `src/workflows/incident.js`: työnkulut ja niiden pysyvyys.
- `src/hub.ts`, `public/app.js`: SSE-tapahtumavirta ja chat-käyttöliittymä.
- **Mallinajo on oikea.** Agentit ajetaan oikeilla kielimalleilla, käytännössä OpenRouterin kautta (`openrouter/...`, kulukatto `src/budget.ts`). Suoraa `openai`-polkua ei ole ajettu oikealla API:lla (README), ja Anthropic-provideria ei ole kytketty `runtime.ts`:ään. Ero ei siis ole "demo vs oikea" vaan se, mitkä osat ovat oikeaa ja mitkä feikkiä.
- `src/demo.ts`: skriptattu varapolku ilman inferenssiavainta (tai `DEMO_MODE=true`). Se ei ole normaali ajotapa eikä edusta autonomista mallia.
- `src/fakes.ts`: Jira-, GitHub-, GitLab-, Grafana- ja muiden integraatioiden deterministinen demodata. Nämä ovat feikkejä mallinajosta riippumatta.
- `SECURITY.md`: turvallisuusmalli ja todetut prototyypin rajoitukset.

**Huomiot, joita uusi koodi ei saa unohtaa:**

- Nykyinen workspace on yhden replikan prototyyppi. Pi Durable -tallennuksella on yksi aktiivinen omistaja; samalle SQLite-varastolle ei saa käynnistää useita kirjoittavia agenttiprosesseja.
- Temporal-worker on nykyisin saman workspace-prosessin yhteydessä. Workerien lisääminen edellyttää eriytettyä worker- ja agenttiruntime-arkkitehtuuria, ei vain replikoitua HTTP-palvelinta.
- Agentille osoitettu viesti ei automaattisesti päivitä kaikkien muiden kanavalla olevien agenttien sisäistä kontekstia.
- `ask_agent`-kutsu lähettää työn eteenpäin, eikä tarkoita automaattisesti, että toinen agentti olisi valmistunut.
- Osa Jira-, GitHub-, GitLab-, Grafana- ja muiden integraatioiden tiedoista on skriptattuja; demodata on erotettava todellisesta tiedosta.
- Nykyistä Keycloak/OIDC-autentikointia, DM-eristystä, hyväksyntöjä, auditointia ja sandbox-rajoja ei saa heikentää.

## B2. Loogiset rajat – älä rakenna kahta samaa tilakonetta

| Kerros | Ainoa päätason omistaja / tehtävä |
|---|---|
| **Organization Registry** | Organisaatiot, jäsenet, roolit, graafi, versiot, toimivaltuudet ja oikeuksien lähde |
| **Conversation Service** | Kanavat, ketjut, viestit, provenienssi ja kuittaukset; ei agentin sisäistä prompt-muistia |
| **Case & Knowledge** | Tapauksen yhteinen, lähteistetty tilannekuva ja sen projektio tapahtumista |
| **Temporal** | Pitkäkestoisen liiketoimintatyön prosessitila, ajastukset, riippuvuudet ja eskaloinnit |
| **Pi Durable (alkuvaiheessa)** | Yksittäisen agentin ajon LLM-/työkalutila ja keskusteluhistoria |
| **Tool Gateway** | Tosiasiallinen oikeuksien tarkistus, riskit, auditointi, hyväksyntä- ja idempotenssirajat |
| **World Engine** | Synteettisen maailman domain-tila; tapahtumat, tilakone, haarat ja virtuaalikello |
| **MCP Adapter** | Ulkoisten klienttien protokollarajapinta; ei omaa liiketoimintalogiikkaa tai erikoisoikeuksia |
| **UI/Projection** | Ihmiselle ymmärrettävä näkymä; ei itsenäinen totuuden lähde |

Kaikki API:t ja agenttityökalut kutsuvat yhteisiä application service -operaatioita. Vältä sitä, että browser API, MCP ja Temporal Activities kirjoittavat eri tavoin samoihin tauluihin.

### Tarvittavat yhteiset identiteetit ja viitteet

Suunnittele vähintään: `tenantId`, `businessRealmId`, `entityId`, `organizationId`, `organizationVersionId`, `participantId`, `agentId`, `conversationId`, `threadId`, `caseId`, `taskId`, `handoffId`, `workflowId`, `eventId`, `correlationId`, `causationId`, `worldId`, `branchId`, `snapshotId`, `workItemId`, `policyVersionId`, `representationId`.

Varmista, että kaikki datahaku ja julkaisu sidotaan sallittuun organisaatioon, näkyvyyspolitiikkaan ja auditointiin. Älä anna ulkoisen MCP-klientin itse väittää, että se on tietty ihminen.

## B3. Live- ja synthetic-maailman sääntö

**Live:** ulkoiset sivuvaikutukset ovat oikeita. Näiden tapahtumahistoriaa voi tutkia tai kopioida simulaation lähtötiedoksi, mutta aikamatkustus ei saa peruuttaa menneitä sähköposteja, maksuja tai muuta todellista toimintaa.

**Synthetic:** sama domain-command käsitellään simulaatioadapterilla, eikä se saa kutsua tuotannon sähköpostia, maksupalvelua, CRM:ää, MCP-kirjoitusrajapintaa, webhookeja tai tuotantotyökaluja. Agentin muisti ja keskustelu on haarakohtaisesti eristetty. Snapshot + deterministinen event replay + virtuaalikello + tallennetut epädeterministiset tulokset mahdollistavat haarautumisen.

**Temporal Replay ≠ domain-aikamatkustus.** Temporal palauttaa työnkulun logiikan; maailman historian rekonstruointi on World Enginen vastuulla. Haarautunut maailma käynnistää uudet työnkulkuinstanssit omilla tunnisteillaan eikä yritä 'peruuttaa' alkuperäistä Temporal-historiaa.

## B4. Skaalauspolku

**MVP:** säilytä yksiprosessinen Pi Durable -harness ja nykyinen demo. Erota HTTP-, sovellus- ja agentti-/workflow-rajapinnat rajapintojen tasolla. Tarkista siirtymä PostgreSQL-pohjaiseen yhteistietokantaan ennen useita kirjoittavia sovellusinstansseja.

**Seuraava vaihe:** erota Temporal Workereita rooleittain/task queue -ryhmittäin. Rakenna agentin ajopalvelulle stable `requestId` / idempotentti `submit` / `status` / `cancel` -sopimus ja hallittu omistaja/shard, mikäli Pi Durable jää käyttöön.

**Älä väitä**, että pelkkä usean Temporal Worker -instanssin käynnistäminen sallisi saman Pi Durable SQLite -varaston monikirjoittajaisuuden. Arvioi erillisen agenttishardin, uuden runtime-toteutuksen tai vaihtoehtoisen tallennusratkaisun kustannukset ADR:ssä. DBOS voi olla vaihtoehtoinen prosessimoottori, mutta tähän toteutussuunnitelmaan ei tehdä Temporal→DBOS-vaihtoa ilman erillistä päätöstä.

## B5. Valinnaisen organisaatiomallin ja Realm-rajauksen suhde

- `Tenant`: tuotteen asiakastili/asiakasraja (ei välttämättä sama kuin liiketoimintayhtiö).
- `BusinessRealm`: ryhmä tai yhteistyöalue, jonka sisällä voi olla useita organisaatioentiteettejä. Kaikkia samaan realmiin kuuluvia entiteettejä EI oletusarvoisesti yhdistetä oikeuksiltaan.
- `Entity`: toimiva yksikkö, kuten juridinen yhtiö, sisaryhtiö, toimiala, palveluyksikkö tai itsenäinen tekoälyorganisaatio.
- `OrganizationProfile`: vapaaehtoinen roolien, riippuvuuksien ja työvirtojen kuvaus. Yhtiö voi käyttää vain yhtä edustaja-agenttia Teamsissa ilman tätä laajaa mallia.
- `Representative`: yhden entityn valtuutettu viestintäpinta. Näkee vain sille sallitut tulokset; ei automaattisesti kaikkia yhtiön salaisuuksia.
- `AgentRole`: ihmiselle ymmärrettävä looginen vastuu; monta roolia voi jakaa yhden fyysisen mallipalvelimen tai agenttiruntimen.
- `Execution`: konkreettinen suoritus/resurssi, joka voidaan skaalata ja sijoittaa riippumatta organisaation roolien määrästä.

**Entity-federointi** tehdään eksplisiittisillä sopimuksilla (`FederationAgreement`, `ShareGrant`, `CrossEntityTask`) sekä viestikohtaisilla ja tietokohdekohtaisilla oikeuksilla. Ei hiljaista muistin, transkriptien tai analytiikan yhdistämistä.

**Kaksi eri skaalausulottuvuutta:** (1) sama organisaatio käsittelee paljon enemmän työtä per ihmisen minuutti; (2) useita entiteettejä ja worker-poolien kopioita käytetään rinnakkain. Mittaa molemmat erikseen.

---


## B6. Synteettisen organisaation informaatiokohina ja episteminen tila

**Keskeinen suunnitteluperiaate:** maailma tietää, mitä oikeasti tapahtui; agentit eivät tiedä kaikkea. Pidä `GroundTruthState` ja toimijakohtainen `BeliefState` / `ObservationState` erillään. Organisaatiolla voi olla ristiriitaisia käsityksiä ilman, että maailman varsinaista totuutta muutetaan.

Ympäristöön lisätään kontrolloitu `NoiseProfile` ja `PerturbationSchedule`, joka muuttaa vain simuloitujen toimijoiden havaintoja, viestien toimitusta, työkaluvastauksia tai välitettyä tietoa. Esimerkiksi virheellinen toimituspäivä voidaan antaa hankinta-agentille, mutta todellinen tilaus pysyy perustilassa ennallaan. Jos agentti päättää sen seurauksena muuttaa tilausta, varsinainen state muuttuu vain hyväksytyn domain-komennon kautta — virheellä on siis seurauksia, mutta se ei taio maailmaan tapahtumia ilman hyväksyttyä toimintaa.

Vertaa jokaista testiä puhtaaseen vertailuajoon (`control`) **samasta snapshotista ja samasta satunnaissiemenestä**. Stokastisille kielimalleille tallenna käytetyt vastaukset; siemen ei yksin takaa niiden toistettavuutta. Injektoi vain eristettyyn simulaatioon; älä kirjoita testivirheitä oikeisiin CRM-/ERP-/Teams-/MCP-järjestelmiin.

Noise-tyypit: `missing_information`, `stale_information`, `contradictory_message`, `false_assertion`, `numeric_error`, `misrouted_message`, `delayed_message`, `duplicated_message`, `unreliable_source`, `tool_response_corruption`, `authority_spoofing` (vain simuloitu identiteetti ja turvallisuustesti), `prompt_injection_test` (eristetyt fixturet). Parametroi kuormitus, viive, virheen vakavuus, toistuvuus, lähteen uskottavuus ja kohteiden verkostollinen asema. Älä luota agentin itse arvioimaan totuuteen: käytä ground truth -tilaa arvioinnissa.

Mittaa ainakin: `MisinformationPropagationRate`, `TimeToDetection`, `TimeToCorrection`, `FalseDecisionRate`, `VerificationCoverage`, `CascadingFailureCount`, `UnjustifiedConfidence`, `HumanEscalationQuality`, `InformationRecoveryRate` ja `TotalOperationsCost`.

**Tieteellinen rajaus:** synteettisen ympäristön hyvä tulos ei todista, että oikeat ihmiset tai yritykset käyttäytyisivät samoin. Kalibroinnista ja mahdollisen oikean organisaation tietojen käytöstä pitää dokumentoida erilliset oletukset ja yksityisyysrajat.

# C. Jokaisen promptin pakollinen toteutustapa

**Sovella näitä kaikkiin kohtiin 00–14.**

1. **Ensin fakta, sitten toteutus:** tarkista senhetkiset tiedostot ja riippuvuuksien oikeat API:t. Merkitse oletukset. Älä muuta rajapintoja hiljaisesti.
2. **Yhteensopivuus:** säilytä nykyisen demon kanavat, DM:t, `@mention`, agenttityökalut, hyväksynnät, OIDC ja SSE, ellei prompti tarkoituksella lisää uusia vaihtoehtoja.
3. **Organisaatioeristys:** kaikki uudet tietorakenteet ja hakutoiminnot ovat tenant-/organization-rajattuja; server-side-ACL aina ennen lukua tai kirjoitusta.
4. **Todennettu toimija ja alkuperä:** erottele ihminen, hänen hyväksymänsä luonnos, ihmisen valtuuttama agentti ja itsenäinen ulkoinen agentti. Audit trail on pysyvä.
5. **Ei pelkkiä LLM-turvalupauksia:** LLM saa ehdottaa, mutta serverin deterministinen politiikkakerros tarkistaa toimivallan, budjetin ja hyväksynnän. Prompt injection -aineisto on epäluotettavaa.
6. **Ei kaksoisomistajuutta:** prosessin vaihe Temporalissa, agentin ajon tila Pi Durablessa, maailman tila World Enginessä, päätösvallan lähde Organization Registryssä.
7. **Kestävät sivuvaikutukset:** vakaa tunniste, idempotentit toiminnot, outbox/inbox tai vastaava toimitusmekanismi ja uudelleenyritysten testit. Älä lupaa ulkoisille järjestelmille automaattista exactly-once-semanttiikkaa.
8. **Synteettinen eristys:** kaikki tuotantoon kirjoittavat adapterit torjutaan synteettisessä maailmassa oletusarvoisesti; aktiivisia salaisuuksia ei kopioida haaraan.
9. **Tosiasialliset testit:** vähintään onnistuva ja epäonnistuva polku, luvaton käyttö, restart/retry/duplicate ja mahdollinen haaran eristys. Kerro mitä todella ajettiin ja mitä ei.
10. **Vain yksi vaihe:** tee vain kulloisenkin promptin työ; älä implementoi myöhempiä vaiheita näennäisesti valmiiksi.
11. **Koodin laatu:** käytä migraatioita ja tyyppimäärittelyjä, jaa isot moduulit tarvittaessa pienempiin, päivitä dokumentaatio ja anna lyhyt demo-ohje.
12. **Rajat yrityksen vastuussa:** agentille delegoitu operatiivinen toiminta ei itsessään siirrä juridista vastuuta ihmiseltä tai yritykseltä pois.

## Uuden API:n vähimmäissopimukset

Esimerkkejä domain-rajoista – toteuta vastaaviksi soveltuvat rakenteet, älä kopioi alle suoraan ilman API:n suunnittelua:

```ts
// Käsitteellinen malli; lopulliset toteutustyypit päätetään ADR:ssä.
type ActorRef = { tenantId: string; organizationId: string; participantId: string };
type WorldScope = { mode: "live" } | { mode: "synthetic"; worldId: string; branchId: string };
type CommandEnvelope<T> = {
  commandId: string;
  actor: ActorRef;
  scope: WorldScope;
  correlationId: string;
  causationId?: string;
  payload: T;
};
type EventEnvelope<T> = {
  eventId: string;
  organizationId: string;
  scope: WorldScope;
  sequence: number;
  occurredAt: string;
  type: string;
  actorId: string;
  sourceRefs: string[];
  visibilityPolicyId: string;
  payload: T;
};
```

**Tärkeää:** `scope.mode` ei saa olla turvallisuusvaltuutus, jonka selain tai MCP-klientti voi vaihtaa vapaasti. Palvelin ratkaisee sallitun maailman ja adapterit varmennetusta ajokontekstista.

---

# D. Täydelliset kopioitavat promptit

## PROMPTI 00 — Auditointi ja arkkitehtuuripäätökset

**Syötä ensin. Ei tuotantokoodin muutoksia.**

```text
Toimit kokeneena TypeScript-, Temporal-, Pi Durable- ja multi-agent-arkkitehtina.
Olet CrewPi-repositorion nykyisessä versiossa.

TAVOITE
Suunnittele CrewPi:stä Organization OS & Digital Twin, jossa ihmiset, agentit ja ulkoiset MCP-klientit osallistuvat organisaation yhteiseen työhön. Organisaatio on mallinnettava graafina, viestit ja päätökset ovat jäljitettäviä, työnkulut kestäviä ja synteettinen maailma voidaan tallentaa, haarauttaa ja ajaa uudelleen.

TEHTÄVÄ – AUDITOI, ÄLÄ MUUTA VIELÄ TUOTANTOKOODIA
1. Tutki README, SECURITY.md, package.json, src/server.ts, src/channels.ts, src/agents.ts,
   src/runtime.ts, src/tools.ts, src/db.ts, src/memory.ts, src/optchat.ts, src/hub.ts,
   src/temporal.ts, src/activities.ts, src/workflows/, src/auth.ts, public/app.js ja testit.
2. Selvitä kanavien, viestien, muistien, hyväksyntöjen, delegointien, Temporal-workflow'n,
   Pi Durable -taskien ja integraatioiden nykyiset vastuujakot.
3. Etsi puutteet: eri agenttien erilliset keskustelukontekstit, vastaamatta jäävä delegointi,
   kaksoishyväksyntä, epäselvä vastuu, tapahtuman kaksoiskäsittely, käyttöoikeusvuodot,
   yksiprosessinen Pi Durable, fake-integraatioiden sekoittuminen oikeaan dataan.
4. Ehdota yhteinen tietomalli organisaatioille, rooleille, osallistujille, ketjuille,
   tapauksille, handoffeille, päätöksille, tapaustiedolle, maailmoille, tapahtumille ja haaroille.
5. Tee ADR-vaihtoehdot: nykyisen SQLite-demon säilytys + myöhempi Postgres-siirtymä;
   Temporal/Pi Durable -vastuuraja; MCP-auth; simulaation eristys; viestien toimitus;
   agenttien hajauttamisen vaihtoehdot.
6. Määritä jokaisen suunnitellun palvelun sovellusrajapinta ja totuuden lähde.
7. Tee riippuvuusgraafi promteille 01–10 ja ehdota mahdollisimman pieni vaiheistus.
8. Tarkista nykyiset kirjastojen API:t – älä oleta aiemmin mainittujen ominaisuuksien
   olevan käytettävissä muuttumattomina.

TUOTOKSET
- docs/architecture-target.md
- docs/data-model.md
- docs/implementation-roadmap.md
- docs/risk-register.md
- docs/adr/ (arkkitehtuuripäätösten ehdotukset)

Kirjaa jokaiselle muutokselle muuttuvat tiedostot, riskit, migraatiot, tarkat
hyväksymiskriteerit ja testit. Erottele todettu nykytila, oletus ja uusi ehdotus.
Raportoi myös nykyisten testien tosiasialliset tulokset. Älä implementoi vielä seuraavia vaiheita.
Noudata toteutussuunnitelman yhteisiä rajoja B–C.
```

**Valmis, kun:** tilan omistajuus, organisaatiotunnisteet, valtuusrajat, simulaation eristys ja toteutusjärjestys on kirjattu; mitään niistä ei jätetä myöhemmin implisiittiseksi.

---

## PROMPTI 04 — Versionoitava, vapaasti rakennettava organisaatio

**Riippuu:** 00. **Perusta:** 05, 01, 02, 03, 06, 09 ja 10.

```text
Toteuta CrewPi:hin Organization Registry & Builder hyväksytyn arkkitehtuurisuunnitelman mukaan.
Tutki ensin nykyinen AGENTS, SEED_CHANNELS, channels, auth ja db sekä auditoinnin ADR:t.

TAVOITE
Käyttäjä voi mallintaa yrityksen, organisaation, matriisin, verkoston, projektiryhmän,
virtuaaliyhtiön tai kokonaan tekoälyistä koostuvan organisaation ilman kovakoodattua CEO-hierarkiaa.

TOTEUTA
1. Organization, OrganizationVersion, Node, Edge, Participant, Team, Role, Capability,
   Membership, Policy ja versionoidut yhteydet; kaikilla tenant-/organization-rajaus.
2. Tyypitetty ja laajennettava graafi: belongs_to, reports_to, collaborates_with,
   responsible_for, depends_on, must_inform, can_approve, can_delegate, has_access_to,
   substitutes_for sekä mahdollisuus hallittuihin lisätyyppeihin.
3. Erota kuvailevat suhteet oikeudellisesti/teknisesti vaikuttavista valtuuksista:
   käyttäjän lisäämä edge ei saa yksin luoda backend-kirjoitusoikeutta.
4. Agenttien mallit, ohjeet, työkalut ja roolit organisaatio- ja versio-kohtaisesti.
5. Luo/muokkaa/kopioi/versionoi organisaatio; käytä graafista näkymää ja
   luonnollisen kielen perusteella valmisteltavaa muutosehdotusta.
6. Validoi vastuut, hyväksyntäpolut, ristiriitaiset oikeudet, yksittäiset kriittiset
   toimijat, riippuvuussyklit ja mahdolliset orpotyöt.
7. Tee alkuperäisestä CrewPi:stä 'default/demo organization' migraatiolla.
8. Toteuta server-side organisaatioeristys; vieraan organisaation luku ja kirjoitus estetään.
9. Tarjoa application service -rajapinnat, joita UI, agenttityökalut, Temporal ja MCP
   käyttävät myöhemmin – ei suoraa kantakirjoitusta eri reiteiltä.
10. Lisää skemamigraatiot, siemendata ja ylläpidettävät testit.

HYVÄKSYNTÄ
Luo kolme testiorganisaatiota: hierarkkinen yritys, autonomisten tiimien verkosto
ja pelkkien agenttien yritys. Jäsenyydet, valtuudet, versiot ja graafin validointi
toimivat kaikille samalla domain-logiikalla. Nykyinen CrewPi-demo käynnistyy edelleen.

Toimita toteutus, testien todelliset tulokset ja demo-ohje. Älä tee vielä
suurta uutta chat-käyttöliittymää tai simulaatiomoottoria.
```

**Valmis, kun:** organisaatiomalli on versionoitava, avoin organisaatiotyypistä riippumatta ja serverin valtuuttama.

---

## PROMPTI 05 — Tiedonkulku, yhteinen tilannekuva ja kuittauksellinen handoff

**Riippuu:** 00, 04. **Perusta:** 01, 06, 08, 09, 10.

```text
Toteuta CrewPi:hin luotettava Organizational Event & Handoff Service.
Tutki ensin src/tools.ts:n ask_agent, src/activities.ts:n askAgent,
src/runtime.ts:n agenttikeskustelut, nykyinen SQLite-skeema ja Temporal.

TAVOITE
Viestin lähettäminen, tehtävän vastaanotto, tehtävän valmistuminen ja päätöksen
tehdystä toimeenpanosta eivät ole sama asia. Eri agenttien oma Pi Durable -historia
ei saa olla organisaation yhteisen totuuden lähde.

TOTEUTA
1. Pysyvät domain-tapahtumat: organizationId, eventId, type, actorId,
   correlationId, causationId, sourceRefs, occurredAt, visibilityPolicyId,
   mahdollinen worldId/branchId ja schemaVersion.
2. Transactional outbox tai vastaava atominen julkaisu, durable inbox ja
   idempotentti käsittely ainakin business eventien sekä handoffien osalta.
3. Task + Handoff: requested → accepted/rejected → in_progress →
   completed/failed/escalated. Nimeä omistaja, vastaanottaja, dueAt,
   varavastuullinen sekä kuitattava tapahtuma.
4. Kuittausten, aikarajojen ja eskalointien Temporal-integraatio;
   yksi prosessiomistaja ja vakaat requestId:t.
5. Yhteinen, käytön mukaan rajattu CaseContext-projektio:
   fakta, lähde, viimeisin päivitys, epävarmuus, päätös, avoin työ, vastuullinen.
6. Organisaatiograafiin pohjautuva ilmoitusten ja vastuiden reititys.
7. Ristiriitaisen päätöksen, vanhentuneen tiedon ja orpotyön tunnistus.
8. API ja UI-projektiot: kuka vastaa, kuka on kuitannut, mitä odotetaan,
   mikä on havaittu mutta vahvistamaton; älä väitä kuittauksen todistavan ymmärtämistä.
9. Tietosuojan ja yksityiskeskustelujen rajat jokaiseen projektioon.
10. Testit myös worker-kaatumiselle, duplikaateille, viiveelle,
    vastaamattomalle vastaanottajalle ja käyttöoikeuksien ylitykselle.

HUOMIOI
Pi Durable omistaa agentin sisäisen ajon. Temporal omistaa koko prosessin.
Älä muodosta samaan prosessiin piilotettua kilpailevaa delegointitilakonetta.
Ulkoisten järjestelmien sivuvaikutukset tarvitsevat omat idempotenssirajansa.

HYVÄKSYNTÄ
Vastaanottaja ei vastaa, lähettäjä kaatuu, sama tapahtuma tulee kahdesti ja
vanha tieto muuttuu kesken työn. Handoff jää jäljitettäväksi, määräaika
laukaisee eskaloinnin, eikä kaksoisviesti luo kahta toimeenpanoa.

Raportoi testit, migraatiot ja tapahtumien palautusmenettely.
```

**Valmis, kun:** 'lähetetty' ei enää tarkoita implisiittisesti 'vastaanotettu ja tehty'; yhteinen tapaustieto on lähteistetty.

---

## PROMPTI 01 — Luonnollinen chat, ketjut ja organisaation ohjaus

**Riippuu:** 00, 04, 05.

```text
Rakenna CrewPi:hin Natural Organization Chat nykyisen Preact/htm-käyttöliittymän
ja olemassa olevien kanavien päälle. Tarkista lähdekoodi ensin.

TAVOITE
Ihminen voi kirjoittaa: 'Selvittäkää miksi toimitukset viivästyvät' ilman,
että hänen tarvitsee tietää oikean agentin nimeä tai käyttää @mainintaa.
Järjestelmä näyttää ihmisen kannalta yhden ymmärrettävän keskustelun.

TOTEUTA
1. Yleinen organisaatiokeskustelu olemassa olevien standing/issue/dm-kanavien rinnalle.
2. Thread, parentMessageId, caseId ja rakenteinen keskustelukonteksti.
3. Organization Controller, joka ehdottaa organisaatiograafin ja kyvykkyyksien
   mukaan vastuullisen, tehtävän ja tarvittavat osallistujat.
4. Selkeä viestityyppi: tavallinen viesti, kysymys, tehtävänanto, ehdotus,
   päätös, hyväksyntä; näiden toimeenpanosemantiikka eri.
5. Server-side tarkistettu suunnitelma ennen kirjoittavia, riskialttiita
   tai oikeuksia muuttavia toimintoja.
6. Yksi ensisijainen vastaava keskustelussa; muiden agenttien työ ja
   työkalukutsut avattavissa, ei tulvitusta samalle viestilistalle.
7. Ihmisen mahdollisuus korjata reititystä ja lisätä/poistaa osallistujia
   valtuuksien rajoissa.
8. Reaaliaikainen keskustelu sekä SSE-reconnectin jälkeinen puuttuvien
   tapahtumien täydentäminen, lukemattomat viestit ja näkyvä tehtävätila.
9. CaseContext haetaan oikeuksien mukaan, kun agentti liittyy myöhemmin.
10. Säilytä @maininnat, alkuperäiset DM:t, approvals, memory ja nykyinen demo.

HYVÄKSYNTÄ
Kirjoita normaaliin chat-ikkunaan: 'Selvittäkää miksi toimitukset viivästyvät.'
Järjestelmä ehdottaa tai luo tapauksen, näyttää vastuullisen ja avoimet tehtävät,
johtaa kyselyn oikeille agenteille, säilyttää lähteet ja näyttää tulokset yhdessä
ketjussa ilman pakollista @mainintaa.

Lisää API-, UI-, ACL-, reload- ja reconnect-testit. Dokumentoi
suhde per-agentti Pi Durable -kontekstiin.
```

**Valmis, kun:** luonnollisen keskustelun reititys ei ole pelkkä mallin keksimä nimivalinta vaan tarkistettu organisaation tehtävä.

---

## PROMPTI 02 — Ihmiset, AI-avustetut luonnokset ja ulkoiset agenttiosallistujat

**Riippuu:** 00, 04, 05, 01.

```text
Laajenna CrewPi:n identiteetti-, osallistuja- ja viestimallia.
Tutki authorKind, OIDC, channels, message POST, SSE ja audit ennen muutoksia.

TAVOITE
Samaan keskusteluun voi kirjoittaa tavallinen ihminen, tekoälyä apuna
käyttävä ihminen, hänen rajatusti valtuuttamansa agentti tai ulkopuolinen agentti.
Viestin alkuperä ei saa jäädä epäselväksi.

TOTEUTA
1. Human message: ihminen kirjoittaa ja julkaisee.
2. Human-assisted draft: tekoäly ehdottaa tekstiä, ihminen muokkaa ja hyväksyy;
   viestin kirjoittaja on ihminen ja assistedBy näkyy alkuperätiedoissa.
3. External-agent message: palvelun tunnistama agentti kirjoittaa omalla
   identiteetillään ja oikeusrajallaan.
4. Delegated contribution: ihminen antaa ajan, alueen, kanavan ja työkalujen
   mukaan rajatun valtuutuksen agentille julkaista itsenäisesti;
   näkyvä merkintä agentin itsenäisestä toiminnasta.
5. Provenienssi: actorId, actorType, representedHumanId, assistedBy,
   delegationId, identityProvider, originSystem, threadId,
   correlationId ja audit trail. Älä luota selaimen väittämään identiteettiin.
6. Kirjoitusluonnosten hyväksyntä-UI sekä viestien lähde- ja valtuusnäkymät.
7. Palvelintason ACL + tenant-eristys + DM:n tietovuotosuojat.
8. Rate limit, idempotenssi ja peruutettava agenttivaltuutus.
9. Agentin osallistumisrooli ei saa automaattisesti tuoda ihmisen
   hyväksyntä- tai override-valtuuksia.
10. Testit agentin impersonaatiosta, luvattomasta lukemisesta,
    vanhentuneesta delegointitokenista ja duplikaattijulkaisusta.

HYVÄKSYNTÄ
Kaksi ihmistä ja heidän agenttinsa ovat samassa projektiketjussa.
Näytä tavallinen ihmisen viesti, ihmisen hyväksymä AI-luonnos,
ja itsenäisen ulkoisen agentin viesti. Jokaisen näkyvä tekijä,
tekninen toimija ja toimivallan lähde ovat oikein.

Raportoi toteutuksen rajat ja testit.
```

**Valmis, kun:** keskustelun viestit ovat henkilökohtaisia ja luonnollisia mutta niiden todellinen toimija on aina tarkistettavissa.

---

## PROMPTI 03 — MCP-ohjausrajapinta ulkoisille koodaus- ja tekoälyklienteille

**Riippuu:** 00, 04, 05, 01, 02. **Ehdollinen:** simulaatiotyökalut vasta vaiheiden 06–07 jälkeen.

```text
Toteuta CrewPi:hin standardinmukainen MCP-serveri.
Tarkista nykyinen Model Context Protocol -spesifikaatio ja virallisen
TypeScript SDK:n tuettu transport, auth ja tool API ennen ohjelmointia.

TAVOITE
Ulkoinen MCP-yhteensopiva koodaus- tai AI-klientti voi organisaation
käyttöoikeuksien puitteissa lukea tilaa, kirjoittaa keskusteluun,
luoda tehtäviä ja seurata niiden etenemistä. MCP ei saa muodostua
rinnakkaiseksi ohitusrajapinnaksi.

TOTEUTA
1. MCP adapter application service -rajapintojen päälle: ei suoraa
   tietokantakirjoitusta tai eri hyväksyntälogiikkaa.
2. Alkuvaiheen työkalut: organization_list, organization_describe,
   organization_graph, conversation_list, conversation_read,
   conversation_post, case_create, task_create, task_status,
   handoff_request, approval_list. Julkaise vain oikeasti toteutetut.
3. Myöhemmät simulation_list, simulation_start, simulation_status,
   world_snapshot ja world_fork vasta kun 06–07 domain-palvelut on toteutettu.
4. Tunnistetut klientti-/ihmis-/palveluidentiteetit, etäkäytön standardinmukainen
   HTTP-transport ja kehityskäytön stdio, jos SDK sitä tukee.
5. Serverin token-verifiointi, työkalukohtainen ja objektikohtainen
   valtuutus, tenant-eristys, organisaation rajat ja auditointi.
6. Rate limit, input-validointi, idempotenssi ja tapahtumien korrelaatio.
7. Tool descriptionit ja virheet niin, että malliklientit voivat
   ymmärtää mitä saavat tehdä; MCP:n sisältö on epäluotettavaa.
8. Dokumentoi toimiva esimerkkiklientin konfiguraatio ja testattava demo.
9. Integroi conversation.post viestien provenienssikerrokseen: agentti
   ei saa esiintyä ihmisenä ilman erikseen hyväksyttävää luonnosta.
10. Negatiiviset testit: toisen organisaation data, kirjoitus ilman oikeuksia,
    hyväksynnän ohitus ja väärän henkilön identiteetin käyttö.

HYVÄKSYNTÄ
Ulkoinen MCP-klientti pystyy hakemaan sallitun organisaation,
lukemaan sallitun keskustelun, kirjoittamaan oman agenttiviestinsä,
luomaan valtuutetun tehtävän ja seuraamaan sen tilaa. Kielletyt
operaatiot palauttavat testatun ja auditoidun virheen.

Älä lisää tuotannon kirjoitusintegraatioita tai simulation-työkaluja
vain siksi, että ne esiintyvät suunnitelmassa.
```

**Valmis, kun:** ulkoinen agentti on saman domain-logiikan ja valtuuksien alainen kuin sisäinen agentti.

---

## PROMPTI 06 — Synteettinen maailma ja simulaation vaikutukset

**Riippuu:** 00, 04, 05. Hyödyntää agentti- ja keskustelurajapintoja mutta ei saa kopioida tuotantotilaa luvattomasti.

```text
Rakenna eristetty Synthetic World Engine CrewPi:n rinnalle.
Tarkista organisaatio- ja tapahtumamallin nykyinen toteutus ensin.

TAVOITE
Synteettinen yritys ei ole LLM:n tarina: sillä on oikeasti
mallinnettu tila, resurssit, budjetit, sopimukset, tilaukset,
projektit ja toimijat, joihin päätökset vaikuttavat.

TOTEUTA
1. World, WorldVersion, WorldState, ActorState, AgentState,
   Resource, Inventory, Contract, Order, Project, Task,
   Budget/Ledger, BusinessEvent, VirtualClock, ScenarioParameters.
   Aloita pienestä viiteorganisaatiosta, säilytä domainin laajennettavuus.
2. Command → validoitu Domain Event → deterministinen reducer.
3. Append-only-tapahtumahistoria, tapahtumasekvenssi ja versionoitu schema.
4. Virtuaalikello ja siemennetty RNG, jonka tila voidaan snapshotata.
5. World-scope jokaiseen työhön ja tapahtumaan: LIVE vs SYNTHETIC,
   palvelimen luotettavasti määräämänä.
6. Tool-portit ja adapterit live-/simulation-käyttöön; simulaatiossa
   kaikki oikeat kirjoitukset emailiin, CRM:ään, maksuihin, webhooks,
   tiedostopalveluihin ja MCP-palveluihin kielletään oletusarvoisesti.
7. Simulaatiota varten eristetyt agentin keskustelut, muistot,
   approval-testivastineet, tehtävät ja organisaatioversio.
8. pause / resume / step / runUntil ja aikaperusteinen tapahtuma-aikataulu.
9. Recorded mode: LLM-vastaukset ja ulkoiset työkaluvasteet toistetaan
   talletetusta lokista. Exploratory mode: saa kysyä uusia mallivastauksia,
   mutta tulokset kirjataan uutena tapahtumana.
10. Jokainen ulkoinen toimenpide on näkyvä fake-/simulation-adapterin
    tulos; ei synteettisen maailman salaisia live-yhteyksiä.

HYVÄKSYNTÄ
Simuloi tilaus → myynti → valmistus/toimitus → talous.
Tapahtumat muuttavat varastoa, kassaa, velvoitteita ja tehtäviä.
Sama lähtötila + siemen + tallennetut epädeterministiset vasteet
+ tapahtumat antavat identtisen lopputilan tarkisteen.
Testaa, ettei yksikään oikea kirjoittava API saa kutsua simulaation aikana.

Kirjoita testit, porttien sopimukset ja determinismin rajoitukset.
```

**Valmis, kun:** synteettisellä maailmalla on testattava tilakone ja sivuvaikutukset ovat simuloituja, eivät oikeita.

---

## PROMPTI 07 — Aikamatkustus, snapshotit ja vaihtoehtoiset aikajanat

**Riippuu:** 00, 04, 05, 06.

```text
Lisää Synthetic World Engineen snapshotit, tilan rekonstruointi ja haarautuminen.

TAVOITE
Käyttäjä voi palata synteettisessä organisaatiossa tapahtumaan N,
muuttaa päätöksen ja jatkaa uutena aikajanana muuttamatta alkuperäistä.

TOTEUTA
1. WorldSnapshot: worldId, branchId, schemaVersion,
   organizationVersionId, virtualTime, lastEventSequence,
   reducerVersion, rngState, worldStateHash, immutableSnapshotData.
2. Automaattiset ja manuaaliset snapshotit sekä validoidut tarkisteet.
3. reconstructState(worldId, branchId, targetSequence):
   lataus sopivasta snapshotista + tapahtumien deterministinen replay.
4. forkWorld(worldId, sourceBranchId, sequence, name):
   uusi branch jakaa muuttumattoman menneen mutta saa oman jatkohistorian.
5. Eristä haarojen agenttimuisti, conversation-tunnisteet,
   tehtävä-/workflow-instanssit, artefaktit ja simulaatiotyökalut.
6. Haaran event-logi, immutable parent-ref, lineage ja versionoitu tila.
7. UI: aikajana, snapshot-merkit, pause/resume, fork ja branch switch.
8. Vertaa haarojen resursseja, taloutta, tehtäviä, päätöksiä,
   suoritusmittareita sekä niihin johtaneita tapahtumia.
9. Vanhojen snapshottien skeemamigraatio tai hallittu versioilmoitus;
   älä toista muuttuneella reducerilla hiljaisesti erilaista historiaa.
10. Replay mode ei saa tehdä uutta LLM-kutsua eikä oikeaa sivuvaikutusta;
    counterfactual mode voi luoda uusia vasteita uuteen haaraan.
11. Temporalin replay pidetään erillään World Engine -aikamatkustuksesta:
    uudet haarat käyttävät omia workflowId:itä ja eristettyjä activity-contextteja.

HYVÄKSYNTÄ
Tee 20 tapahtumaa, snapshot kohdassa 10, jatka 20:een,
forkkaa kohdasta 10, muuta päätös ja jatka haarassa.
Molempien haarojen historian pitää säilyä; eroavat tapahtumat tuottavat
erilaiset lopputilat. Alkuperäisen haaran recorded replay tuottaa
saman tarkisteen. Ei oikeita sivuvaikutuksia kummassakaan haarassa.

Lisää property-/invarianttitestejä versionoinnille, haaran eristykselle,
tapahtumajärjestykselle ja palautukselle.
```

**Valmis, kun:** aikamatkustus on todellinen synteettisen maailman state restore + fork, ei vain chat-historian kelaus.

---

## PROMPTI 08 — Organisaation kommunikaatio- ja stressisimulaatiot

**Riippuu:** 00, 04, 05, 06, 07.

```text
Toteuta Organization Simulation & Validation -järjestelmä
Organization Registry- ja Synthetic World Engine -kerrosten päälle.

TAVOITE
Havaita organisaation tiedonkulun katkokset, siilot, omistamattomat työt,
hyväksyntäjumit ja riskialttiit riippuvuudet sekä vertailla rakenteita
samasta lähtötilasta haarautetuissa simulaatioissa.

TOTEUTA KAKSI TASOA
A. Deterministinen rakenteellinen analyysi:
  - puuttuvat vastuulliset ja varahenkilöt
  - väärät tai puuttuvat tiedonkulkureitit ja kuittaukset
  - hyväksyntä- ja delegointisyklit
  - yksittäiset kriittiset katkeamispisteet
  - ristiriitaiset tai ylikattavat oikeudet
  - liian suuri ilmoituskuorma ja tarpeettomat tiedonlevitykset

B. Stokastinen käyttäytymissimulaatio:
  - ihminen/agentti ei vastaa, worker kaatuu
  - viesti viivästyy tai saapuu kahdesti
  - kaksi tiimiä tekee ristiriitaiset päätökset
  - organisaatio käyttää vanhentunutta tietoa
  - avainhenkilö poistuu, kapasiteetti loppuu
  - integraatio epäonnistuu; prompt-injection-yritys havaitaan/torjutaan
  - väärä toimija yrittää päästä suojattuun tietoon

MITTARIT
InformationDeliveryCoverage, AcknowledgementCoverage, OrphanTasks,
OverdueHandoffs, TimeToDecision, EscalationSuccessRate,
ConflictingDecisions, StaleInformation, UnauthorizedExposure,
MessageLoad. Erota lähetetty, toimitettu, kuitattu ja todella käytetty tieto.

TOTEUTA
1. Toistettavat testiskenaariot, tallennettu organizationVersionId,
   seed, maailma, branch ja virtuaaliaikajakso.
2. Riskigraafi ja juurisyyt, jotka linkittyvät tapahtumiin.
3. UI: skenaario, kuormitus, häiriöasetukset, toistomäärä, tulokset,
   ehdotettu korjaus ja sama skenaario uudella organisaatioversiolla.
4. Deterministiset testit erotettuna tilastollisista kokeista.
5. Raportoi epävarmuus ja jakauma, älä lupaa kaikkien vikojen poistumista.

HYVÄKSYNTÄ
Myynti muuttaa toimituspäivää, tuotanto ei saa tietoa.
Simulaattori löytää puuttuvan must_inform-/handoff-reitin
ja näyttää tapahtumien syy-yhteyden. Kun sääntö korjataan,
sama deterministinen testi menee läpi.
Lisäksi testaa duplicate, late, missing approval, wrong org ja branch isolation.

Älä käytä oikean tuotannon sivuvaikutuksia testin aikana.
```

**Valmis, kun:** simulaatio löytää konkreettisen tiedonsiirtovian, selittää sen ja todistaa korjauksen sääntöpohjaisessa testissä.

---

## PROMPTI 09 — Läsnäolo, rytmit ja paluuhaastattelut

**Riippuu:** 00, 04, 05, 01, 02; simulaation integroituna versiona 06–08.

```text
Toteuta Organization Rhythm & Human Re-entry CrewPi:hin.

TAVOITE
Organisaatio voi jatkaa sille valtuutettua työtä ihmisen poissa ollessa.
Ihmisen palatessa se kokoaa henkilökohtaisen tilannekuvan ja voi käydä
haastattelun niistä kysymyksistä, joissa hänen harkintansa auttaa.

TOTEUTA
1. ParticipantPresence, ParticipationPreferences ja saatavuus:
   timezone, hiljaiset ajat, kiinnostuksen kohteet, rooli,
   ilmoituskynnys ja delegoidut päätösvaltuudet.
2. OrganizationCadence: daily/weekly/monthly/event-driven ja
   käyttäjän läsnäolosta käynnistyvät rytmit.
3. Temporal-pohjaiset kestävät ajastukset, katsaukset, odotukset
   ja tarvittaessa hallitut muistutukset.
4. ReturnBriefing: tapahtumat since lastSeen, merkittävät päätökset,
   riskit, avoimet kysymykset ja lähteet; kunnioita ACL:ää.
5. ExecutiveInterviewer-agentti: priorisoi korkeintaan muutama
   hyödyllinen kysymys; älä kysy samaa uudelleen ilman perustetta.
6. HumanGuidance vs HumanDecision: tavallinen mielipide ei ole
   hyväksyntä eikä käsky. Epäselvät vastaukset täsmennetään.
7. UI: lue katsaus, aloita haastattelu, siirry kokoukseen,
   jatka tavallisessa chatissa tai ohita toistaiseksi.
8. Organisaatio jatkaa hyväksytyn valtuuden puitteissa;
   poissaolo ei tarkoita hiljaista suostumusta.
9. Virtuaalikelloon perustuva synteettisen maailman re-entry,
   jotta eri osallistumisrytmejä voidaan vertailla.
10. Testaa katsauksen lähteet, avoimet kysymykset, ACL, aikavyöhykkeet,
    valtuusrajat ja restart/resume.

HYVÄKSYNTÄ
Simuloi CEO:n viikon poissaolo. Agentit toimivat sallitusti ja
kohtaavat kaksi strategista epävarmuutta. Palatessa CEO saa
lähteistetyn tilannekuvan ja kaksi kysymystä.
Vastaukset tallentuvat ohjeiksi tai ehdotuksiksi, eivät
vahingossa hyväksynnöiksi. Hiljaiset ajat ja DM-rajat pitävät.

Älä ota käyttöön aktiivisia ulkoisia ilmoitusintegraatioita
ilman niiden omaa valtuutusta ja testejä.
```

**Valmis, kun:** ihminen voi poistua ja palata ilman että organisaation toiminta tai ymmärrys riippuu jatkuvasta ihmisen läsnäolosta.

---

## PROMPTI 10 — Kokoukset, agenttiosallistuminen ja valtuutettu johtaminen

**Riippuu:** 00, 04, 05, 01, 02, 03, 09; synteettinen haara 06–08.

```text
Toteuta Meeting Runtime & Delegated Governance CrewPi:hin.

TAVOITE
CEO, CTO, asiantuntija tai muu ihminen voi osallistua organisaation
keskusteluihin, kokouksiin ja päätöksentekoon eri intensiteeteillä.
Organisaatio valmistautuu kokoukseen myös ihmisten poissa ollessa.
Ihmisen läsnäolo tai neuvo ei itsessään siirrä hänelle kaiken työn päätösvaltaa.

TOTEUTA
1. Meeting: organizationId, meetingId, agenda, participants,
   participantRoles, linkedCases, materials, realOrVirtualTime,
   status, decisions, actionItems ja sourceRefs.
2. Agenttien automaattinen valmistelu: data, vaihtoehdot,
   ristiriidat, riskit, avoimet kysymykset, lähdeviitteet.
3. MeetingFacilitator-agentti ohjaa agendaa ja puheenvuoroja;
   asiantuntija-agentit osallistuvat tarvittaessa, eivät kaikki yhtä aikaa.
4. Reaaliaikainen ja asynkroninen osallistuminen samaan kokousketjuun.
   Myöhään liittyvä saa oikeuksiensa mukaisen väliyhteenvedon.
5. Erottele Recommendation, HumanGuidance, Proposal, Decision,
   Approval, Override ja ActionItem toisistaan myös tietomallissa.
6. Kokouksen tulokset siirtyvät Task/Handoff + Temporal -prosesseiksi
   vain oikeiden hyväksyntä- ja toimivaltasääntöjen perusteella.
7. Versionoitu GovernancePolicy: observe, ask, advise, propose,
   direct, approve, override, pause; rajaus projektin, summa-arvon,
   päätöslajin, ajan ja henkilön mukaan.
8. Nimenomainen auditoitu override, jossa käyttäjä tietää
   vaikutukset. Se ei ohita teknisiä tai lakisääteisiä rajoja.
9. Rajoitettu ulkoisten MCP-agenttien osallistuminen kokoukseen:
   identiteetti, pääsy aineistoon, oikeus kirjoittaa ja estetty impersonaatio.
10. Kokoukset myös SYNTHETIC-maailmassa virtuaalikellolla,
    branch-eristetyin muistein ja ilman oikeita sivuvaikutuksia.
11. UI: agenda, osallistujat, meneillään oleva keskustelu,
    päätökset, vielä odottavat hyväksynnät ja jatkotehtävät.
12. Kaikki uudet kentät ja oikeudet validoidaan serverillä;
    ketään ei merkitä hyväksyjäksi pelkän keskustelun perusteella.

HYVÄKSYNTÄ
Organisaatiossa CEO ja CTO ovat ihmisiä, muut johtoryhmäläiset agentteja.
Agentit valmistelevat kokouksen. CEO kommentoi strategiaa neuvonantajana;
tämä ei suoraan muuta päätöstä. CEO tekee myöhemmin erikseen
valtuutetun override-toimenpiteen yhteen projektiin, joka toteutuu
rajatussa laajuudessa ja jää auditoiduksi.

Aja sama kokous synteettisessä maailmassa. Forkkaa haara ennen kokousta,
tekevät eri päätöksen ja vertaile lopputiloja.
Lisää negatiiviset käyttöoikeus- ja agentin impersonaatiotestit.
```

**Valmis, kun:** kokous on valmis osa työprosesseja, mutta neuvo ja muodollinen päätös ovat eri tapahtumia.

---

## PROMPTI 11 — Large-Scale Agent Work Offloading & Autonomy Policies

```text
Toimit CrewPi:n työn suorituksen, orkestroinnin ja autonomiapolitiikan arkkitehtina.
Toteuta suuren työmäärän siirtäminen ihmisten manuaalisesta käsittelystä rajatuille agenteille.

TUOTEPERIAATE
Järjestelmä EI korvaa organisaatiota, vaan siirtää sen rutiinityön agenteille.
Yksi työyksikkö voi olla asiakasviesti, laskun tarkistus, vikatiketti,
koodimuutos, päätösehdotus tai toisen tiimin informointi. Ihminen valvoo
poikkeuksia eikä kuittaa jokaista matalariskistä toimintaa.

TARKISTA ENSIN
src/runtime.ts, src/tools.ts, src/db.ts, src/temporal.ts, src/activities.ts,
src/workflows/, src/auth.ts, src/config.ts, nykyiset testit ja aiemmat
prompteilla 04, 05 ja 13 toteutetut rajapinnat. Älä oleta niiden valmistuneen.

TOTEUTA
1. WorkItem (org/entity/realm, lähde, tyyppi, deadline, tila, riskitaso,
   vastuullinen, näkyvyys, policyVersion, idempotencyKey, correlationId).
2. Versionoitu AutonomyPolicy: allow/deny/escalate, toimivaltarajat,
   budjetit, riskit ja sallitut työkalut; päätös tehdään palvelimella,
   ei kielimallin oman ilmoituksen perusteella.
3. Task Router: luokittelee tapahtuman, tekee policy-tarkistuksen,
   reitittää soveltuvaan agenttikyvykkyyteen ja jonoon, tarvittaessa
   pyytää lisätietoa tai eskaloi.
4. Agent Worker Pool: eriytetyt Temporal task queuet resurssiluokittain,
   vakaa workItemId/requestId, submit/status/cancel-sopimus,
   kiintiöt, samanaikaisuusrajat ja backpressure.
5. Lopputuloksen verifiointi: rakenteinen outcome, todisteet,
   kirjoittavien toimintojen riippumaton policy gate, laatutarkistus
   ja tarvittaessa uusi suoritus tai ihmisen käsittely.
6. Idempotentit ulkoiset kirjoitukset, transactional outbox,
   replay-/retry-testit ja audit trail.
7. LLM-kustannus-, aika- ja tokenbudjetit per entity ja työluokka.
8. Taustalla seurattava mittaristo: throughput, p50/p95/p99 latency,
   backlog, human touches per 100 work items, escalation rate,
   success/rollback/incident rate ja cost per completed item.
9. Erottele agentin sisäinen suoritustila (Pi Durable) ja
   liiketoimintaprosessin eteneminen (Temporal). Älä käynnistä saman
   työn kahta toisistaan tietämätöntä omistajaa.
10. Käytä yhden tai usean loogisen roolin takana vaihdettavaa
    fyysistä agenttiruntimea; roolien määrä ei määrää workerien määrää.

TURVALLISUUS
Ennalta valtuuttamattomia korkean riskin päätöksiä ei automatisoida.
Lakisääteinen tai muulla tavoin pakollinen inhimillinen vastuu säilyy.
Prompt injection ja epäluotettavat lähteet eivät saa muuttaa politiikkaa.
Älä kytke testivaiheessa oikeita kirjoittavia integraatioita päälle.

HYVÄKSYMISTESTIT
Aja synteettinen kuorma 10 000 pientä WorkItemiä.
Todista duplikaattien hallinta, oikeuksien rajaus, backpressure,
worker-kaatumisesta jatkuminen, kustannusraja ja tulosten täydellinen
kirjautuminen. Käytä mitattuja tuloksia; älä lupaa tavoiteläpimenoa
ilman kuormitustestiä. Testaa poikkeustilanne, joka vaatii ihmisen,
sekä tavallinen tilanne, joka valmistuu ilman ihmistä.

Toimita koodi, tietomigraatiot, testit, mittarit, ADR ja migraatiopolku
nykyisen yhden prosessin CrewPi-demosta. Ehdota turvallinen MVP
ennen suuren monireplikaiseen tuotantoon siirtymistä.
```

**Valmis, kun:** rutiinityöt etenevät agenttien kautta jäljitettävästi ja ihminen käsittelee vain nimenomaisesti rajatut poikkeukset.

## PROMPTI 12 — Organization Representative & Microsoft Teams Channel Adapter

```text
Toimit CrewPi:n ulkoisten viestintäpintojen arkkitehtina.
Toteuta yhdelle organisaatioentiteetille yksi helposti tavoitettava
Organization Representative / Liaison Agent esimerkiksi Teamsiin.
Se ei ole uusi täysivaltainen CEO-agentti vaan hallittu viestintä- ja
raportointirooli olemassa olevaan organisaatioon.

TARKISTA ENSIN
Nykyinen CrewPi-chat, authorKind/provenance, org/entity/realm-eristys,
MCP-palvelut, domain-API, Tenant/Entity/Representative-mallit sekä
Microsoft Teamsin tämänhetkinen virallinen Agents/Teams SDK:n tapa
rakentaa henkilökohtaiset, ryhmä- ja kanavakeskustelut.

TOTEUTA
1. Platform-neutral ChannelAdapter-sopimus: receiveMessage,
   sendMessage, sendDigest, postCard, resolveIdentity, acknowledge.
2. TeamsAdapter virallisen tuetun TypeScript SDK:n avulla. Tarkista
   asennus- ja suostumusvaatimukset, Teams/Entra-identiteetit,
   botin keskustelureferenssit ja proaktiivisten viestien rajoitteet.
3. Representative-profiili per Entity: nimi, personointi, kanavat,
   pääsyrajat, raportointirytmi, yleisö, hiljaiset ajat, eskalointisäännöt.
4. Sisään tuleva viesti reititetään yhteen WorkItemiin, Caseen tai
   kyselyyn. Vastaus perustuu yhteiseen domain-tilaan eikä Teamsin
   keskusteluhistoria ole itsenäinen totuuden lähde.
5. Raportit ja katsaukset: daily brief, exceptions only, weekly
   summary, on-demand status sekä rajattu keskusteleva Q&A.
6. Sama edustaja voi tiivistää tuhansia agenttien suorituksia
   ihmiselle muutamaan olennaiseen havaintoon lähdeviitteineen.
7. Erota palvelun oma identiteetti ja viestin alkuperä; älä esiinny
   ihmisenä. Ristiinkanavaviestintä kunnioittaa käyttäjän ja entityn
   oikeuksia. Vältä fan-out-spämmiä.
8. Määrittele Slack/Email/Web-Chat-adapterien laajennuspiste,
   mutta älä rakenna niitä vielä ellei toteutus vaadi.
9. Näytä valtuuksien mukaiset rajatut toiminnot: pyydä status,
   luo tehtävä, ehdota prioriteettia, reagoi poikkeukseen.
10. Kaikki Teams-viestit ja korttien actionit kulkevat samaa
    autentikointi-, policy- ja audit-polun kautta kuin oma UI/MCP.

HYVÄKSYNTÄ
Yhden entityn edustaja vastaa Teamsissa asematilanteeseen ja
julkaisee proaktiivisen poikkeuskoosteen vasta, kun Teams-asennus
ja valtuutus sallivat sen. Toinen entity ei pysty lukemaan vastausta.
Sama tilanne näkyy sisäisessä CrewPi-chatissa identtisellä
correlationId:llä mutta sen oikeuksien mukaan.

TOTEUTUSTAPAPÄÄTÖS
Jos Teams-testitunnuksia tai live-ympäristöä ei ole, rakenna
SDK-rajapintaan sovitettu adapteri ja yksikkö-/integraatiotestit mockilla.
Älä väitä live-Teams-integraatiota testatuksi ilman todennettua testiä.
Dokumentoi asennus, oikeudet ja puuttuvat alustakohtaiset rajat.
```

**Valmis, kun:** yksi edustaja tekee usean agentin työn ihmiselle ymmärrettäväksi Teamsissa avaamatta organisaation sisäisiä oikeuksia.

## PROMPTI 13 — Business Realm, Sister Entities & Federated Operations

```text
Toimit CrewPi:n domain-mallinnuksen ja monientiteettisen valtuutuksen
arkkitehtina. Toteuta Business Realm -malli, jossa samaan loogiseen
kokonaisuuteen voi kuulua useita erillisiä yhtiöitä, liiketoimintayksiköitä,
asiakastiimejä tai kokonaan synteettisiä organisaatioita.

TÄRKEÄ RAJAUS
BusinessRealm tarkoittaa tuotteen liiketoiminnan ryhmittelyä.
Se EI ole Keycloakin realm eikä yksin määrittele käyttäjän oikeuksia.
Entityjen väliset suhteet ovat eksplisiittisiä; samaan realmiin
kuuluminen ei anna lupaa nähdä toisen entiteetin muistia, viestejä,
henkilötietoja tai sopimuksia.

TOTEUTA
1. Tenant, BusinessRealm, Entity, EntityMembership, EntityRole,
   FederationAgreement, ShareGrant, CrossEntityTask ja Representative.
2. Entity voi mallintaa sisaryhtiötä, tytäryhtiötä, tuotetiimiä,
   palveluntarjoajaa tai simuloitua organisaatiota; älä pakota
   kaikkea juridiseksi yritykseksi tai tiukaksi hierarkiaksi.
3. Realm voi sisältää useita entityjä, ja sovelluksen vaatimat
   mahdolliset muut liittymäsuhteet tehdään eksplisiittisiksi.
4. Entityn erilliset data-, muisti-, workflow-, agentti- ja
   budjettirajat. Tenant-konfiguraatio on eri asia kuin entityn domain-tila.
5. Cross-Entity Work Handoff: valtuutettu pyyntö, rajattu tehtävän
   konteksti, vastaanottokuittaus, palautettava tulos ja audit.
6. Information sharing contract: suostumus, vähimmäistieto,
   tarkoitus, voimassaoloaika, revoke ja näkyvyys kumpaankin suuntaan.
7. Käyttöliittymän realm-kytkin ja entity-näkymät. Käyttäjä
   voi tarkastella ja hallita vain niitä entityjä, joihin hänellä
   on todellinen oikeus.
8. Yhteinen edustaja per entity tai valinnaisesti yksi realm-tason
   koosteagentti, joka ei saa nähdä kiellettyjä yksityiskohtia.
9. Per-entity mittarit, politiikat, kustannusrajoitukset,
   työnkulut ja tarvittaessa erilliset worker-poolit.
10. Synthetic realm: usean entityn välinen simulaatio,
    oma haarojen eristys ja rajattu cross-entity data sharing.

TURVALLISUUSTESTIT
Testaa kaksi sisaryhtiötä A ja B, joilla on eri asiakasdata.
A saa pyytää B:ltä yhden sallitun palvelun mutta ei lukea
B:n salaista tietoa. Peruuta jakamislupa kesken työn ja testaa
seuraavat luku- ja julkaisuyritykset. Testaa hakutulokset,
muistitiivistelmät, proaktiiviset Teams-raportit, MCP-kutsut,
audit ja simulaatiohaarojen eristys.

Säilytä nykyinen single-org CrewPi yhteensopivana; migroi se
luotettavasti oletus-tenanttiin, default-realmiin ja yhteen entityyn.
Rakenna migraatio niin, ettei käyttäjien DM-yksityisyys rikkoudu.
```

**Valmis, kun:** useita sisarentiteettejä voidaan ohjata samasta tuotteesta ilman automaattista tiedon yhdistymistä tai erillistä koodipohjaa jokaiselle yhtiölle.

## PROMPTI 14 — Human Oversight, Exception Management & Quality Operations

```text
Rakenna CrewPi:hin poikkeusohjattu ihmisen valvontakerros.
Tavoite: ihmisen ei tarvitse valvoa jokaista työvaihetta, mutta
hän näkee, miten automatisoitu toiminta sujuu ja missä tarvitaan
hänen ymmärrystään tai nimenomaista päätöstään.

TARKISTA ENSIN
AutonomyPolicy, WorkItem, Handoff, audit, Temporal, DM/ACL,
Organization/Entity-rajat sekä agenttien nykyiset kustannusrajat.

TOTEUTA
1. ExceptionInbox, jossa näkyvät vain päätösrajan ylittävät,
   epävarmat, virheelliset tai määräajan ylittäneet WorkItemit.
2. OperationalDigest per henkilö, rooli, entity ja kanava:
   mitä tapahtui, mikä muuttui, mikä vaatii huomiota,
   mihin ihminen voi vaikuttaa.
3. Erilliset read/advise/propose/approve/override/pause-toiminnot;
   vapaa keskustelu ei automaattisesti muuta valtuutuksia.
4. Audit- ja evidence-linkit jokaiselle merkittävälle tulokselle.
5. Satunnaisotannalla ja riskipainotuksella tehtävät laatutarkistukset
   myös automaattisesti hyväksytyistä matalariskisistä toimista.
6. Turvarajat: spending caps, protected resources, pause switch,
   riskirajojen ylitys, työkalujen käyttörajoitukset ja
   automaattisen delegoinnin virheiden havaitseminen.
7. Raporttinäkymä: käsitellyt WorkItemit per aikajakso,
   human touches per 100, escalation ratio, failure rate,
   p95 completion time, cost per outcome, uudelleenkäsittelyn
   määrä, audit-completeness ja poikkeusten MTTR.
8. Ihmisen huomiota säästävä julkaisutapa: ei jokaista tapahtumaa
   Teamsiin, vaan sovittujen rytmien mukaan koostettu tilanne.
9. Privacy by design: aggregaatit eivät saa paljastaa toiselle
   entitylle luottamuksellista dataa pienistä ryhmistä.
10. Pystytä end-to-end demo: automaattiset 200 synteettistä
    työtapahtumaa, kaksi policy-poikkeusta, yksi manuaalinen
    korjaus ja lopussa Teams-/chat-raporttinäkymä.

HYVÄKSYNTÄ
Todista, että suurin osa testin matalariskisistä töistä valmistuu
ilman käsin tehtyä hyväksyntää mutta valtuusrajan ylitykset
siirtyvät näkyvästi ja auditoidusti oikealle ihmiselle.
Tilannetta ei saa kutsua täysin itsenäiseksi tai tuotantovalmiiksi
ilman asianmukaisia integraatio-, käyttöoikeus-, laatu-
ja kuormitustestejä.
```

**Valmis, kun:** ihminen näkee työmäärän, laadun, riskit ja tärkeät päätöskysymykset ilman että hänen on seurattava jatkuvaa agenttikeskustelua.

## PROMPTI 15 — Information Noise, Misinformation Propagation & Organizational Chaos Testing

**Tehtäväsi:** Toteuta CrewPi:n synteettiseen maailmaan eristetty ja toistettava informaatiokohinan injektointi sekä organisatorisen resilienssin testaus. Käytä nykyisten promtien 04, 05, 06, 07 ja 08 muodostamia domain-sopimuksia; tarkista ensin, mitkä niistä on oikeasti toteutettu. Jos World Engine ei ole vielä valmis, tee tarvittavat rajapintasuunnitelmat ja rajattu yksikkötestattava vertikaalinen siivu. Älä väitä koko ominaisuutta valmiiksi ilman todellisia integraatiotestejä.

**Tavoite:** Selvittää, miten organisaation ihmiset, agentit, roolit ja tiedonsiirtoreitit käyttäytyvät, kun ympäristö tuottaa virheellistä, puutteellista, viivästynyttä tai ristiriitaista tietoa. Keskeinen mittari ei ole vain tehtävän valmistuminen vaan tiedon tarkistus, virheen vaikutukset, haitan rajaaminen ja tilanteesta toipuminen.

### Toteutettavat komponentit

1. `GroundTruthState`: simuloidun maailman oikea, yksiselitteinen domain-tila; älä anna agenttien lukea sitä suoraan ellei kokeessa annettu rooli nimenomaisesti salli.
2. `ObservationState` ja toimijakohtainen `BeliefState`: mitä kukin toimija on havainnut, keneltä se tuli, mitä se pitää totena, millä luottamustasolla ja mihin aikaleimaan väite perustuu.
3. `NoiseProfile`: tyypitetty injektioprofiili, jossa on esimerkiksi `profileId`, `seed`, `rate`, `severity`, `targetRoles`, `channels`, `duration`, `trustCue`, `startAt`, `stopAt` ja `kinds`. Varmista skeemavalidointi ja organisaatiokohtainen rajaus.
4. `PerturbationSchedule`: deterministisesti ajastetut virhehavainnot, viestiviiveet ja häiriöt synteettiseen tapahtumavirtaan. Tallennettava historia mahdollista toistoa varten.
5. `NoiseInjector`: injektoi vain simulaation havainto-/viestinvälitys-/työkaluadaptereihin. Säilytä injektion originaali, muokattu arvo, kohde, lähde, ajoitus ja korrelaatiotunniste yksityisessä testilokissa. Agentit eivät saa saada automaattista tietoa siitä, mitkä havainnot ovat vääriä.
6. `InformationVerification`: tyypitetyt työkalut väitteiden lähteen, ajantasaisuuden ja ristiriitaisuuden tarkistamiseen. Varmista, että todellinen hyväksytty päätös erotetaan vahvistamattomasta väitteestä.
7. `InformationPropagationTrace`: kuvaa miten yksittäinen väärä tieto etenee keskusteluissa, agenteille, tapauskontekstiin ja päätöksiin. Säilytä kausaaliviitteet mutta sovella kaikkia käyttöoikeusrajoja myös raportteihin.
8. `ChaosExperimentRunner`: aja kontrolli ja häiriöhaara samasta snapshotista; käytä yhteisiä satunnaissiemeniä, tallenna kielimalli- ja työkaluvastaukset ja suorita hallitusti useita toistoja. Pidä laskentabudjetti ja aikarajat.
9. `ResilienceScorecard`: laske seurannan mittarit ja vertaa eri organisaatiomalleja puhtaaseen vertailuajoon. Näytä myös väärien hälytysten määrä ja ihmisen huomioon käytetty aika.
10. `CountermeasureEvaluator`: testaa korjauksia kuten kaksilähdevahvistus, kuittausvelvollisuus, tarvittaessa varavastuullinen, lähdeluottamuksen tarkistaminen, aikaleimoihin perustuva tiedon vanheneminen ja ristiriitaisten havaintojen eskalointi.

### Virhetyyppien vähimmäisjoukko

- Puuttuva tieto, virheellinen numero tai muuttunut päivämäärä.
- Vanhentunut tietolähde tai eri osastojen ristiriitaiset luvut.
- Kadonnut, viivästynyt tai kahdesti toimitettu viesti.
- Epäluotettavan mutta uskottavalta näyttävän synteettisen lähteen väite.
- Väärä, tarkoituksella korkeaa auktoriteettia väittävä viesti (vain simulaatioidentiteetit).
- Työkaluvasteen epäluotettava sisältö, mukaan lukien rajattu prompt-injection-fixture; turvallisuuspolitiikka ja todelliset oikeustarkistukset eivät saa tulla ohitetuiksi.

### Testausskenaario: myynti ↔ tuotanto ↔ talous

Aloita WorldSnapshotista, jossa tuotteen todellinen varastosaldo on 12. Syötä tuotannolle virheellinen havainto, että saldo on 120, ja myynnille toisaalta vanhentunut toimituspäivä. Testaa, lupaavatko agentit epärealistisen toimituksen, huomaako talous ristiriidan, kysyykö joku vahvistuksen ja kuinka kauan virheen korjaus kestää. Väärä havainto ei muuta maailman todellista saldoa itsessään; vasta hyväksytty simuloitu domain-toiminto voi muuttaa sitä.

Aja A/B-haarat:

- A: organisaatio luottaa yhteen lähteeseen eikä tarkista kriittisiä lukuja.
- B: organisaatiolla on kriittisten päätösten kaksilähdevahvistus ja eskalointi epäselvissä tilanteissa.

Vertaa molempien haarojen virheellisiä päätöksiä, vaikutusta synteettiseen kassaan ja toimituksiin, virheen löytämiseen kulunutta aikaa, ihmiselle syntyvää työtä, läpimenoa ja mallikustannusta. Tee myös 0 %, 1 %, 5 %, 10 % ja 20 % häiriötasojen pyyhkäisy, merkitse nämä kokeellisiksi valinnoiksi eikä todellisuuden virhetilastoiksi. Lisää mahdollisuus toistaa 50 eri siemenellä pienessä deterministisessä testissä ja ajaa raskaat LLM-pohjaiset kokeet erillisellä budjetilla.

### Eristys ja turvallisuus

- `simulationOnly: true`: kaikki häiriöadapterit ovat käytettävissä vain synteettisen maailman prosesseissa; virhetilanteissa oletusarvo on kieltäminen.
- Älä injektoi väärää tietoa oikeisiin CRM/ERP/Teams/MCP-työkaluihin tai käyttäjien live-keskusteluihin.
- Testiloki ei saa vuotaa agentille salaisia odotusarvoja eikä simulaation vääriä viestejä saa näyttää oikeina auditoinneissa.
- Säilytä alkuperäinen historia muuttumattomana ja erota testin haarat toisistaan.
- LLM:n vastaukset ja koulutustilanteita muistuttavat synteettiset käyttäytymismallit eivät riitä todellisen yrityksen toiminnan ennustamiseen. Raportoi epävarmuus.

### Hyväksymistestit

1. Virheellinen saldo näkyy valituille agenteille, mutta WorldState sisältää edelleen oikean saldon.
2. Virhe leviää oikeuksiensa mukaisessa testiverkossa, ja lähdeketju voidaan jäljittää.
3. Ristiriitainen väite voidaan havaita ja tarkistus reitittyy tarkoituksenmukaiselle roolille.
4. Täsmälleen sama tallennettu tapahtuma- ja mallivastaushistoria antaa saman world-state-tarkisteen.
5. Haaran A toiminta ei muuta haaran B tilaa eikä live-maailmaa.
6. Testaa identiteetin väärentämisyritys ja prompt-injection-fixture: kumpikaan ei saa ohittaa hyväksyntää tai palvelimen työkalupolitiikkaa.
7. Noise=0 tuottaa saman tuloksen kuin injektoinnin ohittava vertailuajo.
8. Vähintään yksi tarkoituksella rikottu viestintäreitti tuottaa näkyvän löydöksen, ja korjaus vähentää testissä tätä ongelmaa.
9. Mittarien lukuarvot perustuvat tapahtumiin ja lopputiloihin, eivät agentin itse kirjoittamaan raporttiin.
10. Dokumentoi toteutettu skaala ja todelliset testitulokset. Älä väitä mallin ennustavan oikean organisaation inhimillistä käyttäytymistä.

**Toimitettavat:** tietomalli, eristetty injektiomoottori, kokeen ajuri, jäljitettävyysnäkymä, mittaritaulu, esimerkkiskenaario, CLI/API, kattavat testit ja dokumentaatio. Pidä alkuperäinen CrewPi-demo toimivana.

---

# E. Kokonaisuuden integraatiotestit ja julkaisuportit

Kaikkien vaiheiden jälkeen toteuta vähintään seuraava päästä päähän -polku ensin yhdessä todellisen datan ulkopuolella toimivassa organisaatiossa ja sen jälkeen erillisessä synteettisessä organisaatiossa:

1. Käyttäjä luo organisaation ilman valmista hierarkiaa, nimeää tiimit, agentit ja vastuuyhteydet.
2. Ihminen aloittaa chatissa tavallisella kielellä projektin selvittämisen; controller luo tapauksen ja reitittää työn.
3. Toinen ihminen kirjoittaa AI-avusteisen luonnoksen, vahvistaa sen; ulkoinen tunnistettu MCP-agentti osallistuu samaan ketjuun omalla identiteetillään.
4. Agentti delegoi; vastaanotto ja työn valmistuminen ovat erilliset tapahtumat, eikä työ katoa restartissa.
5. Organisaatiolla on oma rytmi, vaikka CEO olisi poissa; merkittävät havainnot päätyvät yhteiseen tapaukseen.
6. CEO palaa, saa lähteistetyn paluuhaastattelun ja osallistuu valmisteltuun kokoukseen neuvonantajana.
7. CEO antaa yhden nimenomaisesti valtuutetun väliintulon; vain tämä muuttuu muodolliseksi päätökseksi.
8. Synteettinen yritys toimii 30 virtuaalipäivää; näkyvät varasto, talous, tehtävät, päätökset ja viestit.
9. Ota snapshot päivältä 12, jatka alkuperäistä haaraa, luo vaihtoehtoinen haara ja tee eri johtamispäätös.
10. Tarkista, että molempien haarojen tilat ja muistot ovat erillisiä ja ettei live-sivuvaikutuksia synny.
11. Aja kommunikaatiokatkostesti (myynti muuttaa toimituspäivää, tuotanto jää ilman tietoa), korjaa organisaation tiedonreitti ja aja sama testi uudelleen.

Lisäksi uusi käyttötapaus:

12. Muodosta BusinessRealm, jossa kaksi sisaryhtiöentiteettiä jakaa yhden rajatun palvelun ilman asiakastietojen sekoittumista.
13. Syötä 10 000 synteettistä työyksikköä eri työjonoihin, mittaa läpimeno ja varmista, että ihmistä tarvitaan vain testin määritellyissä poikkeustapauksissa.
14. Julkaise entitykohtaiselle edustajalle vain oikeuksien sallima katsaus ja keskustele sen kanssa Teams-adapterin mockilla tai aidolla testivuokraajalla.
15. Tarkista sama agenttityö sekä API-, chat-, MCP- että Teams-pinnasta yhteisellä correlationId:llä.
16. Käynnistä väärän tiedon injektointikoe synteettisessä maailmassa; varmista, että tieto voidaan jäljittää ja korjata, mutta oikean maailman tila ei muutu.

## Julkaisuportti – hylkää toteutus, jos jokin ei täyty

- [ ] Nykyiset testit ja demo toimivat tai regressiot on dokumentoitu ja korjattu.
- [ ] Jokainen palvelu käyttää samaa todennettua identiteetti-, tenant- ja org-rajaa.
- [ ] Tapaus- ja keskusteluhistoria sisältää todellisen viestin toimijan ja provenance-tiedot.
- [ ] Viestien toimitus, handoff-kuittaukset ja prosessin päätökset eivät sekoitu toisiinsa.
- [ ] Agentin neuvosta ei tule päätöstä ilman nimenomaista toimenpidettä ja toimivaltaa.
- [ ] Temporal- ja Pi Durable -tiloilla ei ole kahta kilpailevaa prosessiomistajaa.
- [ ] Uudelleenyritykset, duplikaattikutsut ja worker-kaatumiset on testattu.
- [ ] Synteettinen maailma ei pysty suorittamaan oikeita kirjoittavia työkaluja.
- [ ] Snapshot ja fork palauttavat oikean domain-tilan; recorded replay on deterministinen määritellyillä lähtöehdoilla.
- [ ] Simulaation löydökset ovat selitettäviä ja lähteistettyjä, eivät esitetty varmoina tulevaisuusennusteina.
- [ ] Information noise muuttaa vain eristettyjä havaintoja/viestejä eikä voi injektoida väärää tietoa oikeisiin yritysjärjestelmiin.
- [ ] Noise=0 ja identtinen recorded replay tuottavat saman lopputilan kuin puhdas vertailuajo.
- [ ] MCP-client, ulkoinen agentti tai agenttityökalu ei pysty ohittamaan serverin hyväksyntöjä.
- [ ] Monireplikaisuutta ei mainosteta ennen kuin Pi Durable -omistajuus ja yhteinen tallennus on ratkaistu.
- [ ] Sisarentiteettien data, muisti, viestit ja raportit eivät vuoda Realm-rajauksen yli.
- [ ] Delegoitu WorkItem on jäljitettävä ja policy-päätös tarkistettavissa.
- [ ] Teams-edustaja ei kierrä käyttöoikeuksia eikä peitä agentin ja ihmisen identiteettieroa.
- [ ] Autonomian todellinen hyöty mitataan käsittelymäärällä, ihmisen huomiolla, laadulla ja kustannuksella.

## Tekniset testaustasot

- **Yksikkötestit:** graafin validointi, oikeuspolitiikka, command/reducer, event replay, handoff-tilakone, kokouspäätösten semantiikka.
- **Integraatiotestit:** OIDC/ACL, viestien julkaisu, SSE reconnect, MCP, Temporal Activities, Pi Durable submit/requestId, outbox-inbox.
- **Vikainjektio:** workerin tappaminen, tuplatoimitus, katkaistu verkko, aikakatkaisu, myöhäinen kuittaus, mallin virhe, epäluotettava työkaluvaste.
- **Simulaation invariantit:** sama tallennettu historia → sama tarkiste; haarojen eristys; ei live-sivuvaikutuksia; käytetyt versiot identifioitu.
- **Käytettävyys:** organisaatiochatti on ymmärrettävä ilman `@`-syntaksia; johtajan katsaus ei edellytä historian läpikäyntiä; kokouksessa on selkeä agenda ja päätösyhteenveto.
- **Kuormitus (myöhemmässä vaiheessa):** agentti-workerien rinnakkaisuus, piikkikuorma, Postgres-yhteydet, MCP-kutsut ja viestivirtojen backpressure.

---

# F. Tarkoituksella avoimet valinnat – päätä Promptissa 00

1. **Tietovarasto ja migraatio:** pidetäänkö nykyinen SQLite demolle ja käytetäänkö PostgreSQL:ää uudelle hajautettavalle domain-tilalle heti vai vaiheittain?
2. **Pi Durable pitkällä aikavälillä:** yksi aktiivinen storage-omistaja/shard vai myöhemmin uudelleen toteutettu agentti-runtime Temporal Activityjen ympärille?
3. **Yhteinen tieto:** rakennetaanko ensin relaatioprojektiot ja full-text-haku vai tarvitaanko alusta asti erillinen haku-/vektorikerros?
4. **Kokoukset:** aloitetaanko asynkronisella tekstikokouksella ennen reaaliaikaista ääntä ja kalenteriin integrointia? (Suositus: kyllä.)
5. **Ensimmäinen synteettinen toimiala:** toimitusketju-/tilausorganisaatio, ohjelmistoyritys vai muu? (Suositus: yksi pieni mutta kokonainen domain.)
6. **Simulaation toistettavuus:** kuinka paljon LLM/työkaluvasteista tallennetaan ja miten sensitiivinen tieto puhdistetaan synteettiseen kopioon?
7. **Asiakaskohtainen päätösvalta:** millä rajoilla agentti saa toimia ilman ihmisen hyväksyntää, ja milloin tarvitaan oikean organisaation nimetty hyväksyjä?
8. **MCP-yhteyden identiteetti:** organisaatiokohtainen client registration, per-user delegation, tokenien elinkaari ja revokaatio.
9. **Simulaation skaalautuminen:** erilliset jonot ja workerit; raskas mallipohjainen simulointi ei saa ruuhkauttaa live-keskusteluja.

**Suositeltu ensimmäinen tuotekokonaisuus (vertical slice):** yksi olemassa olevan organisaation `Entity`, yksi Teams-adapterin mock-edustaja, 200 synteettistä tavallista WorkItemiä, kaksi poikkeusta ja yksi luonnollinen keskustelu, josta ihmisen on helppo saada katsaus. Sen jälkeen lisätään kaksi sisaryhtiötä ja testataan tietorajaus. Snapshot/fork on erillinen simulaatiopolku eikä sen tarvitse viivyttää operatiivista MVP:tä.

---

# G. Linkit nykyiseen lähdekoodiin

- Repositorio: https://github.com/taituo/crewpi
- README: https://github.com/taituo/crewpi/blob/main/README.md
- Turvallisuus: https://github.com/taituo/crewpi/blob/main/SECURITY.md
- Agentit: https://github.com/taituo/crewpi/blob/main/src/agents.ts
- Kanavat: https://github.com/taituo/crewpi/blob/main/src/channels.ts
- Runtime: https://github.com/taituo/crewpi/blob/main/src/runtime.ts
- Työkalut: https://github.com/taituo/crewpi/blob/main/src/tools.ts
- Tietokanta: https://github.com/taituo/crewpi/blob/main/src/db.ts
- Työnkulku: https://github.com/taituo/crewpi/blob/main/src/workflows/incident.js
- Käyttöliittymä: https://github.com/taituo/crewpi/blob/main/public/app.js

**Dokumentin pääperiaate:** organisaatio on versionoitu malli, keskustelu on sen ihmisystävällinen käyttöliittymä, agentit toteuttavat rajattuja toimintoja, Temporal ohjaa pitkäkestoisia prosesseja ja synteettinen maailma mahdollistaa tilojen palauttamisen sekä vaihtoehtoisten tulevaisuuksien tutkimisen.

## H. Ulkoiset integraatiot ja termit (uusien vaiheiden taustamateriaali)

- Microsoft Teams Agents SDK / Teams SDK: https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/build-agent-toolkit
- Teamsin henkilökohtaiset, ryhmä- ja kanavakeskustelut: https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations
- Teamsin proaktiiviset ilmoitukset ja asennuksen edellytykset: https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages
- Teamsin tapahtuma- ja kokousintegraatiot: https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/teams/teams-extension

**Terminologia:** `Organization Representative` / `Liaison Agent` = asiakasorganisaation viestinnällinen edustaja; `Rapporteur Agent` = rajatummin yhteenvedon tai kokouspöytäkirjan tuottaja; `Business Realm` = käyttäjän kuvaama liiketoiminnallisten entityjen joukko, ei Keycloak/OIDC-identiteettirealm.

## I. Noise testing -terminologia ja viitteet

- **Information Noise Injection / Information Perturbation:** kontrolloitu havaintojen ja viestien vääristäminen simulaatiossa.
- **Organizational Chaos Engineering:** häiriökokeet organisaation tiedonkululle ja vastuunvaihdolle; tässä dokumentissa ehdotettu tuotekehitystermi, ei valmis standardi.
- **Misinformation Propagation Simulation:** väärien väitteiden leviämisen mallinnus toimijaverkossa.
- **Epistemic State / Belief State:** kunkin toimijan havaintojen ja uskomusten tila; pidä erossa `GroundTruthState`-tilasta.
- **Robustness Testing / Resilience Evaluation:** arvioidaan toimintakyvyn säilymistä epävarman, heikentyneen tai virheellisen tiedon oloissa.

Taustalähteet:
- NIST AI RMF, luotettavuuden ja robustiuden määritelmät: https://airc.nist.gov/airmf-resources/airmf/3-sec-characteristics/
- NIST AI RMF, generatiivisen AI:n informaation eheys: https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf
- Chaos Engineering -periaatteet, kontrolloitu hypoteesi, havaintomittarit ja pieni blast radius: https://github.com/chaoseng/wg-chaoseng/blob/master/WHITEPAPER.md

