---
title: "ADR 0013 — Clients beantragen ihre Zugänge selbst; der Mensch bestätigt nur noch"
whenToUse: "You are about to hand an agent, script or companion app a hand-minted API token, add a scope to apiScope.ts, wire the token-request/approval queue, or you found a built feature nobody ever used because no token carries the scope it needs — this decides how a machine credential comes into existence (client requests, human confirms), which scopes may be self-requested at all, and why the scope vocabulary must exist exactly once."
kind: adr
tags: [adr, decision, tokens, scopes, approvals, mcp, least-privilege, propose]
---
# ADR 0013 — Clients beantragen ihre Zugänge selbst; der Mensch bestätigt nur noch

- **Status:** Accepted (2026-08-25). Die sechs offenen Punkte aus dem Entwurf hat der
  Betreiber delegiert; sie sind unten als *per Empfehlung entschieden* festgehalten.
- **Date:** 2026-08-25
- **Deciders:** @mdopp
- **Betrifft / löst ab:** #2609 (Rückkanal unbenutzbar), #2139 (Token-Antragsschlange),
  #2245 (One-Shot-Elevation), #2326 (Lern-Rückkanal), #2325 (Scope-Sichtbarkeit),
  #2606/#2608 (Token-Bestand, Sammel-Widerruf)
- **Related ADRs:** [0009](adr-0009-service-tokens-and-trust.md) (Token- und
  Vertrauensmodell — dieser ADR ergänzt es um den *Ausstellungsweg*, ändert nichts
  an Scope-Leiter, Speicherformat oder Auflösungsreihenfolge),
  [0011](adr-0011-app-integrations-aggregate-server-side.md) (Companion-App, Pairing)

> Format: Status / Kontext / Entscheidung / Konsequenzen, wie die übrigen ADRs.
> Festgehalten wird, was **nicht aus dem Code ableitbar** ist — inklusive des
> Vorfalls, der die Entscheidung erzwungen hat.

## Context

### Der Auslöser

Der Lern-Rückkanal aus #2326 ist über vier Slices gebaut — Einreichen, Prüfliste,
Abruf, Drift-Erkennung — und wurde **nie benutzt**: `list_learning_proposals` lieferte
eine leere Liste, dauerhaft. Der Grund war kein Desinteresse. `propose_learning`
verlangt den Scope `propose`, und von 34 Token auf der Referenzbox trug ihn **keines**.
Weil Werkzeuge seit #2325 nach Scope sichtbar sind, erschien das Werkzeug in *keiner*
Sitzung. Die Schreibseite existierte, war aber unerreichbar.

Das ist die Fehlerform, um die es hier geht: **etwas ist wirkungslos und sieht aus wie
nichts.** Es gab keine Fehlermeldung, keinen roten Build, keine leere Stelle in der
Oberfläche — nur eine Funktion, die niemand je aufrief.

### Was schon existiert — und wo es abbricht

Der Antrags-/Bestätigungsweg aus #2139/#2245 ist **weitgehend gebaut**: Antrag stellen
(`request_token`, verlangt bewusst nur `read` — sonst bräuchte man die Rechte, die man
beantragt), Antragsspeicher unter `DATA_DIR` mit `0600`, eine Verengungs-Garantie (eine
Bestätigung kann nur *einschränken*, nie erweitern), TTL-Deckel, Einmal-Übergabe des
Geheimnisses beim Abholen (`poll_token_request`), Ansehen über `list_requests`, eine
sitzungsgeschützte Admin-Route zum Bestätigen/Ablehnen, der Genehmigungskern samt
Selbstgenehmigungs-Sperre, die Genehmigungskarten-UI, der SSE-Push auf das Telefon, die
One-Shot-Elevation für `destroy`/`exec` und der delegierte Kind-Mint mit ⊆-Scopes.

Er endet an drei Stellen — alle drei derselbe Bautyp: *Mechanik fertig,
Entscheidungsfläche fehlt.*

**Bruch 1 — der einfache Antrag hat keine Bedienoberfläche.** Die Admin-Route existiert,
aber kein Frontend-Modul ruft sie auf. Der Antragstext verspricht dem Agenten wörtlich
eine Bestätigung unter *Settings → MCP*; dort stehen aber nur die Genehmigungen für
destruktive Werkzeugaufrufe. Belegt auf der laufenden Box: neun Anträge, **acht seit
Wochen `pending`**, der älteste rund sieben Wochen alt. Genau einer wurde je bestätigt —
der One-Shot-Antrag, und der lief über die **Genehmigungskarte**, nicht über die Route.
*Der Weg, der eine Oberfläche hat, wird benutzt; der ohne bleibt liegen.*

**Bruch 2 — Anträge verfallen nie.** Ein `pending`-Eintrag bleibt ewig stehen und zählt
gegen die Obergrenze offener Anträge. Am selben bestätigten Antrag: Bestätigung drei Tage
nach Antragstellung, bei 300 s TTL — der Token war fünf Minuten nach der Bestätigung tot,
und wäre ohnehin nicht mehr ausgehändigt worden. **Eine Bestätigung, die zu spät kommt,
ist wertlos** — ein Argument für Verfall *und* für Push statt Pull.

**Bruch 3 — `propose` wurde nirgends angeboten.** Das Backend akzeptierte den Scope
(`apiTokenRoutes.ts` nutzt das vollständige `ALL_SCOPES` aus `apiScope.ts`). Die
Anlege-Oberfläche führte aber eine **eigene, verkürzte Kopie** der Liste, und der
Frontend-Typ war eine zweite Kopie ohne `propose`. Die Checkbox war nie da. Und weil das
Badge-Mapping ein `Record` über den *lokalen* Typ war, hätte ein Erweitern des
Backend-Typs den Build **nicht einmal rot gemacht**.

Weder Ausstellung noch Prüfung waren kaputt. Es fehlten (a) das *Angebot* des Scopes
beim Anlegen und (b) die *Bestätigungsfläche* für den Antragsweg.

**Nebenbefund, gleiche Klasse:** auch der Review-Weg für Lernvorschläge hat Routen, aber
kein Frontend ruft sie auf. Ein `propose`-Token allein erzeugt also Vorschläge, die im
Dashboard niemand sieht.

### Warum jetzt, und in diese Richtung

Die Kleinlösungen (Scope beim Anlegen anbieten / automatisch vergeben / sein Fehlen
anzeigen) hätten genau diesen einen Scope repariert. Die gesetzte Zielrichtung ist
stattdessen strukturell: *Clients sollen sich für die Entwicklung eigene Schlüssel holen
können, die nur noch bestätigt werden müssen.*

Dazu kommt das Prinzip aus dem Token-Hygiene-Umbau (#2606/#2608): **Reibung skaliert mit
der Tragweite, nicht mit der Wiederholung** — eine getippte Bestätigung, deren Wortlaut
mit dem Blast-Radius der Auswahl wächst. Ein Selbstbedienungsweg, der daneben eine
zweite, reibungsarme Genehmigungsfläche aufmacht, würde diese Arbeit entwerten.

## Decision

**Der Ausstellungsweg für Maschinen-Zugänge kehrt sich um: nicht der Mensch stellt aus und
reicht weiter, sondern der Client beantragt und der Mensch bestätigt.** Der bestehende
Antragsweg wird dafür nicht ersetzt, sondern **fertigverdrahtet, sichtbar gemacht,
klassifiziert und mit Verfall versehen.**

### Der Ablauf

0. **Minimaler Ausgangszugang.** Der Client weist sich mit einem der drei bereits
   existierenden Ausweise aus: dem LAN-only-Bootstrap-Token (ADR 0009 §4, der Regelfall
   für eine frische Entwicklungssitzung), einem vorhandenen schmalen Token, oder einer
   Sitzung, wenn ein Mensch am Gerät sitzt.
1. **Der Client beantragt** — `request_token(scopes, reason, ttl_seconds)`, ergänzt um ein
   Pflichtfeld **`client_label`**: eine selbstgewählte, stabile Kennung der Anwendung. Sie
   wird zum Namen des späteren Tokens und zur Zeile, die der Mensch liest. Die Herkunft
   (`requestedBy`) bleibt daneben **serverseitig gesetzt und nicht client-beschreibbar**.
2. **Der Antrag parkt als Genehmigungskarte.** Die zentrale Änderung: **jeder** Antrag geht
   künftig den Weg, den heute nur der One-Shot-Antrag geht. Damit erbt der einfache Antrag
   ohne neue Infrastruktur die Karte im Dashboard, die Selbstgenehmigungs-Sperre, die
   Persistenz über Neustarts und den **SSE-Push auf das Telefon**. Die Admin-Route bleibt
   als Zweitweg für Scope-Verengung, ist aber nicht mehr der einzige Weg.
3. **Was der Mensch sieht.** Die Karte nennt in dieser Reihenfolge: *wer* (`client_label`
   + Herkunft), *was* in Klartext statt Scope-Namen („darf Dienste anlegen und ändern —
   nicht löschen, keine Shell"), *warum*, *wie lange* (als Datum, nicht als Sekunden), und
   die **Risikoklasse**. Dazu zwei Angaben, die es heute nicht gibt und die die
   Entscheidung erst ermöglichen: *hat dieser `client_label` schon Token?* und *wurde ein
   gleichartiger Antrag kürzlich abgelehnt?*
4. **Der Schlüssel erreicht den Client** — unverändert über den Abruf, **genau einmal**,
   danach aus dem Speicher gelöscht. Das Geheimnis geht nie über die Genehmigungsfläche,
   nie über E-Mail, nie über eine Liste. **Der Mensch kopiert nichts.** Genau darin liegt
   der Gewinn gegenüber heute.
5. **Ablehnung ist ein Endzustand** mit **Cooldown**: ein Antrag *derselben Form* (gleicher
   `client_label`, gleiche Scope-Menge) ist erst nach Ablauf wieder zulässig. Ohne das ist
   „Ablehnen" nur eine Verzögerung, und ein hartnäckiger Client trainiert den Menschen aufs
   Wegklicken.
6. **Zeitablauf** — ein `pending`-Antrag **verfällt**. Ein verfallener Antrag ist nicht mehr
   bestätigbar; der Client muss neu fragen, mit frischer Begründung. Das behebt Bruch 2 und
   verhindert, dass eine Bestätigung einen längst toten Grant mintet.

### Welche Rechte auf diesem Weg beantragt werden dürfen

Die Selbstbedienung senkt die Hürde zum Rechteerwerb — das ist ihr Zweck **und** ihr
Risiko. Der Scope-Raum wird deshalb in drei Klassen geteilt, und die Klasse bestimmt die
Reibung. Die Klassifikation gehört **neben `apiScope.ts`**, damit sie nicht zwischen UI und
Backend auseinanderläuft — das ist die Lehre aus Bruch 3.

| Klasse | Scopes | Selbstbedienung | Bestätigung | TTL-Deckel |
|---|---|---|---|---|
| **A — harmlos** | `read`, `propose` | ja | ein Klick | 30 d |
| **B — aufbauend** | `lifecycle`, `mutate` | ja | ein Klick, aber die Karte listet die Wirkung in Klartext und der Knopf ist erst nach dem Aufklappen aktiv | 7 d |
| **C — erhöht** | `destroy`, `exec`, `reboot` | **nie als stehender Zugang** | nur als **One-Shot**, an eine Operation gebunden, single-use, plus getippte Bestätigung | 10 min |

Damit ist die Frage „was hindert einen kompromittierten Client daran, sich `destroy` zu
erbitten?" strukturell beantwortet: **er kann es nicht.** Ein Klasse-C-Antrag auf einen
stehenden Zugang wird schon bei der Antragstellung abgelehnt, nicht erst beim Bestätigen.
Er kann höchstens eine *einzelne, benannte* destruktive Operation erbitten, die an genau
dieses Werkzeug und diesen Dienst gebunden ist, nach der ersten Nutzung verbrennt und nach
zehn Minuten ohnehin tot ist.

Die getippte Bestätigung für Klasse C folgt dem Muster aus #2608 wörtlich: die Phrase
**nennt die Operation**, nicht nur eine Zahl. Wer das tippt, hat gelesen, was er tippt. Das
ist der Unterschied zwischen einer Entscheidung und einem Reflex — und der Grund, warum die
Reibung für Klasse A *nicht* gilt: **eine Bestätigung, die immer weh tut, tut bald gar
nichts mehr.**

Der **übereifrige** (nicht kompromittierte) Client ist der häufigere Fall. Gegen ihn wirken
Cooldown, Antragsobergrenze, Antragsverfall und die Angabe auf der Karte, ob dieser
`client_label` schon Token besitzt.

**Ausdrücklich nicht angefasst:** die Sitzungs-Cookie-Brücke mit vollen Scopes (ADR 0009)
und der delegierte Kind-Mint, der ohne Menschen auskommt. Der delegierte Mint kann nie
erweitern (`scopesAreSubset`), ist also kein Umweg um die Klassifikation — aber auch kein
Ersatz für sie, denn er setzt einen bereits breiten Eltern-Token voraus.

### Ablauf und Erneuerung

Der Bestand auf der Box ist entstanden, weil jeder Zugang von Hand gemintet und nie wieder
angefasst wurde. Ein Weg, der das Ausstellen *leichter* macht, verschlimmert das, wenn er
nichts dagegen setzt:

1. **Kein selbstbeantragter Token ohne Ablauf.** „Never expires" ist auf diesem Pfad nicht
   anwählbar; der TTL-Deckel je Klasse ist die Obergrenze, nicht der Vorschlag.
2. **Erneuern statt neu ausstellen.** Läuft ein Token in die Karenzzeit, stellt der Client
   einen **Erneuerungsantrag**: gleicher `client_label`, gleiche oder engere Scopes, Verweis
   auf den auslaufenden Token. Die Karte zeigt das als Erneuerung — eine unveränderte
   Erneuerung der Klassen A/B ist eine leichtere Entscheidung als ein Erstantrag. Der alte
   Token wird bei Bestätigung widerrufen, statt danebenzuliegen.
3. **Der Bestand bleibt lesbar.** Die Hygiene-Übersicht aus #2606 bekommt den
   selbstbeantragten Zugang als eigene Herkunft (`createdBy` ist bereits gesetzt), damit
   sichtbar ist, wie viel des Bestands über diesen Weg entstand.

### Die Scope-Aufzählung existiert genau einmal

Bruch 3 war keine Nachlässigkeit im Einzelfall, sondern **eine Kopie, die niemand rot machen
konnte**. Ab hier gilt: `apiScope.ts` ist die einzige Quelle der Scope-Liste; jede
Oberfläche, jeder Typ und jede Erklärung leitet sich daraus ab, und ein Test hält das fest,
statt sich auf den Typprüfer zu verlassen — denn der hat hier bewiesen, dass er es nicht
merkt.

## Decided points — the six the draft left open

Der Entwurf ließ sechs Punkte offen. Der Betreiber hat sie delegiert; sie sind hiermit
**gemäß der Empfehlung des Entwurfs entschieden** und stehen bei erster Umsetzungserfahrung
zur Revision.

1. **Erhält ein selbstbeantragter Zugang `propose` automatisch dazu?** → **Ja, aber sichtbar
   auf der Karte** („zusätzlich: darf Wissensvorschläge einreichen"). Der Scope ist
   niedrigprivilegiert und unabhängig; ihn mitzugeben belebt den Rückkanal in einem Zug. Die
   Sichtbarkeit ist die Bedingung — *stille* Rechteerweiterung ist genau das, was dieser ADR
   sonst vermeidet. Das ist eine ausdrückliche Empfehlung des Entwurfs.
2. **Wie lange darf ein Antrag offen stehen?** → **48 h für Klassen A/B, 30 min für Klasse C.**
   Kürzer heißt mehr Neuanträge, länger heißt wieder Karteileichen.
3. **Darf ein `read`-Token einen `mutate`-Zugang beantragen, oder nur ein Mensch am Gerät?**
   → **Es bleibt beim heutigen Verhalten** (der Antrag verlangt nur `read`). Eine
   kompromittierte Sitzung ist damit einen Klick von mehr Rechten entfernt — aber von einem
   *menschlichen* Klick, auf einer Karte, die Wirkung und Herkunft in Klartext nennt. Der
   Entwurf gab hier keine ausdrückliche Empfehlung; die Abwägung im Text trägt den Status quo.
4. **Ist `client_label` frei wählbar oder aus einer Liste?** → **Frei wählbar.** Es ist
   fälschbar, aber es steht nicht allein: die nicht-fälschbare Herkunft (`requestedBy`) wird
   serverseitig danebengesetzt. Eine gepflegte Liste wäre ehrlicher und wieder Handarbeit
   beim Aufsetzen — der Preis lohnt nicht, solange die harte Angabe daneben steht.
5. **Was passiert mit den Alt-Anträgen?** → **Verfallen lassen** (siehe Migrationsschritt 3).
   Ein Teil davon sind Testanträge, die im Text ausdrücklich um Ablehnung bitten; es gibt
   nichts zu sichten.
6. **Zählt die Nummer 0012?** → **Nein — dieser ADR ist 0013.** Die Kollision aus dem
   Entwurf ist inzwischen aufgelöst: #2617 hat den zweiten „0009" zu
   [ADR 0012](adr-0012-repair-is-reconciliation-not-reinstallation.md) umnummeriert, und
   #2607 hat die ADRs in den Assist-Katalog verschoben. 0012 ist vergeben.

## Migration path — and what of it is built here

Jeder Schritt ist für sich auslieferbar und für sich nützlich.

| # | Schritt | Zustand |
|---|---|---|
| 1 | **`propose` erreichbar machen** — die doppelte Scope-Liste im Frontend entfernen, Liste und Typ aus der Backend-Quelle beziehen, das Badge ergänzen, **plus ein Test, der die UI-Liste gegen `apiScope.ts` prüft** | **gebaut** (#2609) |
| 2 | **Die Antragsschlange sichtbar machen** — eine Section unter *Settings → Access*, die die vorhandenen Routen bedient: auflisten, bestätigen (mit Verengung), ablehnen. Behebt Bruch 1 | Folgearbeit |
| 3 | **Antragsverfall** — Status `expired` + ein Sweep am bestehenden Boot-Timer. Behebt Bruch 2; der Altbestand verfällt beim ersten Lauf | Folgearbeit |
| 4 | **Klassifikation** neben `apiScope.ts` + Prüfung bei der Antragstellung. Ab hier ist der Weg sicherheitsseitig vollständig | Folgearbeit |
| 5 | **Alle Anträge über die Genehmigungskarte** — den bestehenden One-Shot-Zweig auf „immer" ausweiten. Ab hier landen Anträge auf dem Telefon | Folgearbeit |
| 6 | **`client_label`, Cooldown, Erneuerung** — die Bedien-Politur. Erst danach kann das Von-Hand-Minten als Ausnahme markiert werden | Folgearbeit |
| 7 | *(optional, separat)* **Review-Fläche für Lernvorschläge** — der Nebenbefund oben. Ohne ihn erzeugt Schritt 1 Vorschläge, die nur über MCP sichtbar sind. Gehört fachlich zu #2607 | offen |

**Nur zu verdrahten** (Code existiert, wird nicht aufgerufen oder nicht angeboten): Antrag
stellen, abholen, auflisten, bestätigen/ablehnen per API, Verengungs-Garantie,
Einmal-Übergabe des Geheimnisses, One-Shot-Bindung, Genehmigungskarten samt
Selbstgenehmigungs-Sperre und Telefon-Push, `propose` als Scope im Backend, Token-Sweep mit
Karenz, Sammel-Widerruf.

**Wirklich neu:** die Section für die Antragsschlange; der Antragsverfall; die
Scope-Klassifikation samt Verweigerung stehender erhöhter Zugänge; die gestufte Bestätigung
auf der Genehmigungskarte; `client_label`; der Cooldown; der Erneuerungsantrag mit Ersetzen
des Vorgängers; die Klartext-Übersetzung von Scopes in Wirkung.

Grob: **der sicherheitskritische Kern ist gebaut, die Entscheidungsfläche für den Menschen
ist es nicht.**

## Consequences

- **Der Mensch kopiert keine Geheimnisse mehr.** Der Token entsteht nach der Bestätigung und
  wird vom Client abgeholt — der Betreiber sieht ihn nie. Das ist sicherer als der heutige
  Weg (Secret einmal im Browser, dann von Hand weitergereicht) und nebenbei bequemer.
- **Bestätigen wird zur häufigen Handlung.** Damit wird die Qualität der Karte zum
  Sicherheitsmerkmal: eine Karte, die nur eine Scope-Liste zeigt, erzeugt Reflexe. Deshalb
  die Klartext-Wirkung und die Klassenstufung — und deshalb dürfen Klasse-A-Anträge *nicht*
  wehtun.
- **Erhöhte Rechte sind auf diesem Weg nur noch als Einzelfall zu haben.** Wer einen
  stehenden `destroy`-Zugang braucht, mintet ihn weiterhin von Hand unter *Settings →
  Access* — bewusst unbequemer als der Selbstbedienungsweg. Die Bequemlichkeit liegt damit
  auf der sicheren Seite.
- **ADR 0009 bleibt gültig und wird ergänzt.** Scope-Leiter, Speicherformat, LAN-Schranke
  und Auflösungsreihenfolge sind unberührt; dieser ADR beschreibt nur, *wie ein Token
  entsteht*. `propose` ist der erste Scope, der nicht auf der Blast-Radius-Leiter liegt —
  die Klassifikation oben hält das aus, eine reine Leiter täte es nicht.
- **Doppelte Scope-Listen sind ab sofort ein Fehler.** Kandidat für
  [`ARCHITECTURE_INVARIANTS.md`](../docs/ARCHITECTURE_INVARIANTS.md): die Scope-Aufzählung
  existiert genau einmal.
- **Die allgemeine Lehre, über Token hinaus:** eine gebaute Fähigkeit, deren *Zugang* nirgends
  angeboten wird, ist nicht „ungenutzt" — sie ist unerreichbar, und sie sieht von außen
  genauso aus wie eine, die niemand braucht. Wer einen Rückkanal, ein Werkzeug oder eine
  Rolle einführt, liefert im selben Zug den Weg dorthin **und** eine Stelle, an der sein
  Fehlen ablesbar ist.
