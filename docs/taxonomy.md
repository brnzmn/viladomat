# Benchmark taxonomy and quantity patterns

Every invoice line, quote partida and certification item is mapped to one category code. The code
decides which expected-price layers apply (CONTRACT, BUDGET, BENCHMARK, HISTORY), which unit the
quantity must be converted to, and which index series is used. Mapping order:

1. vendor memory (a vendor already mapped to a category keeps it unless the line says otherwise);
2. keyword hits, accent-insensitive and stemmed, in Spanish and Catalan;
3. `claude-sonnet-5` classifier with structured output `{category_code, quantity, unit, confidence,
   rationale, element_scope}` when keywords tie or miss;
4. human override, stored in a separate column so both values stay visible.

`element_scope ∈ {common, private_unit, unknown}` is tagged on every line and feeds rule C11.

## 1. Categories

Layers: **C** contract/quote line, **B** approved budget (resolution amount or ordinary budget line),
**K** benchmark (tier in brackets), **H** own history (same vendor + category, IPC-indexed).
"none (v1)" means the category is `non_benchmarkable` in v1 and P1b prints "no comparable benchmark".

The research list held 42 codes with a separate minor-lighting code; here minor lighting is folded into
`ELECTRICAL`, which keeps 42 codes, and `ASBESTOS` is added after the adversarial review as the 43rd.

| # | Code | Label | ES keywords | CA keywords | Unit | Layers |
|---|---|---|---|---|---|---|
| 1 | ELEV_INSTALL | Lift installation (equipment) | instalación ascensor, elevador, montaje, cabina, maquinaria, paradas | instal·lació ascensor, muntatge, cabina, parades | ud (project) | C, B, K none (v1) |
| 2 | ELEV_CIVIL | Lift civil works | obra civil ascensor, hueco, foso, estructura metálica, cerramiento, recorte forjado | forat, fossat, estructura metàl·lica, tancament, retall forjat | ud / m2 | C, B, K none (v1) |
| 3 | ELEV_MAINT | Lift maintenance | mantenimiento ascensor, conservación, todo riesgo, semi integral, cuota mensual | manteniment, conservació, tot risc | mes | C, K (trade + RD 355/2024 periodicity), H |
| 4 | ELEV_INSPECT | Lift periodic inspection | inspección periódica, OCA, organismo de control, revisión reglamentaria | inspecció periòdica, organisme de control | ud | K (trade), H |
| 5 | ELEV_TELECOM | Lift phone / GSM line | línea telefónica ascensor, GSM, telealarma, rescate | línia telefònica, telealarma, rescat | mes | C, H |
| 6 | FACADE_REHAB | Façade rehabilitation | fachada, revoco, estuco, grietas, hidrofugante, pintura exterior | façana, arrebossat, estuc, esquerdes, hidrofugant | m2 | C, B, K (official BEDEC; trade) |
| 7 | BALCONY | Balcony slab and railing | balcón, losa, canto forjado, voladizo, barandilla, armadura | balcó, cantell, volada, barana, armadura | ml / ud | C, B, K (semi_official CYPE; trade) |
| 8 | SCAFFOLD | Scaffolding | andamio, montaje y desmontaje, alquiler mensual, ocupación vía pública, lona | bastida, muntatge, lloguer, lona | m2·mes | C, K (trade) |
| 9 | ROOF | Roof / terrace | cubierta, terrado, azotea, impermeabilización, tela asfáltica, claraboya, lucernario | coberta, terrat, impermeabilització, claraboia | m2 | C, B, K (trade) |
| 10 | STAIR_REHAB | Staircase rehabilitation | escalera, peldaños, huella, pasamanos, barandilla, mármol, terrazo | escala, graons, passamà, barana, marbre, terratzo | ud / m2 | C, B, K none (v1) |
| 11 | PAINT_INT | Interior painting (common areas) | pintura, pintar, plástica, esmalte, vestíbulo, rellano, techos | pintura, pintar, vestíbul, replà, sostres | m2 | C, B, K (trade) |
| 12 | ENTRANCE_DOOR | Entrance door | puerta entrada, portal, puerta acceso, cierrapuertas, muelle, cerradura | porta d'entrada, portal, tancaportes, pany | ud | C, B, K (trade; heritage caveat) |
| 13 | INTERCOM | Video-entry / intercom | videoportero, portero automático, placa de calle, monitor, telefonillo | videoporter, porter electrònic, placa de carrer, monitor | ud (system) | C, B, K (trade) |
| 14 | WINDOWS | Windows (common elements) | ventana, carpintería aluminio, RPT, vidrio, climalit, persiana | finestra, fusteria d'alumini, vidre, persiana | ud / m2 | C, B, K (trade); C11 scope check |
| 15 | LOCKSMITH | Locksmith | cerrajería, llaves, amaestramiento, copias, bombín | serralleria, claus, còpies, bombí | ud / h | H, K (trade) |
| 16 | ELECTRICAL | Electrical installation and minor lighting | instalación eléctrica, cuadro, luminaria, LED, detector, emergencia, boletín, bombilla, fluorescente, temporizador | instal·lació elèctrica, quadre, lluminària, detector, emergència, butlletí, bombeta, fluorescent, temporitzador | ud / h | C, H, K (trade) |
| 17 | PLUMB_SEWER | Sewer, downpipes, drains | colector, bajante, albañal, desatasco, arqueta, saneamiento, alcantarillado, cámara | col·lector, baixant, clavegueró, desembús, arqueta, sanejament, càmera | ml / ud | C, B, K (trade) |
| 18 | WATER_SUPPLY | Water supply installation | tubería agua, batería contadores, grupo presión, montante, fuga | canonada d'aigua, bateria de comptadors, grup de pressió, muntant, fuita | ud | C, H |
| 19 | MASONRY | Masonry and minor works | albañilería, obra menor, reparación, humedades, yeso, tabique | paleteria, obra menor, reparació, humitats, guix, envà | m2 / h | C, K (trade) |
| 20 | ARCH_PROJECT | Architect project | proyecto básico y ejecución, memoria, planos, visado, arquitecto | projecte bàsic i d'execució, memòria, plànols, visat, arquitecte | % PEM / ud | C (fee agreement), K (trade ratio) |
| 21 | ARCH_DO | Site direction | dirección de obra, dirección de ejecución, aparejador, certificación, visita de obra | direcció d'obra, direcció d'execució, aparellador, certificació, visita d'obra | % PEM | C, K (trade ratio) |
| 22 | HS_COORD | Health and safety coordination | coordinación seguridad y salud, estudio básico, plan de seguridad | coordinació de seguretat i salut, estudi bàsic, pla de seguretat | % PEM | C, K (trade ratio) |
| 23 | ITE | Technical building inspection | inspección técnica edificio, ITE, IITE, certificado aptitud | inspecció tècnica de l'edifici, ITE, IITE, certificat d'aptitud | ud | K (trade) |
| 24 | PERMITS | Municipal permits and taxes | licencia, comunicado, ICIO, tasa, autoliquidación, Ajuntament, ocupación vía pública | llicència, comunicat, ICIO, taxa, autoliquidació, Ajuntament, ocupació via pública | % PEM / €·m2 | K (official OF 2.1 / OF 3.3) |
| 25 | SUBSIDY | Subsidy processing and income | subvención, Consorci, ayudas, gestión expediente, informe | subvenció, Consorci, ajuts, gestió d'expedient | % eligible budget | B, K (official Consorci caps) |
| 26 | ADMIN_FEE | Administrator fees | honorarios administración, cuota administración, gestión | honoraris d'administració, quota d'administració, gestió | €/unit·mes | C (mandate), H, K (trade) |
| 27 | ADMIN_EXTRA | Administrator extras | junta extraordinaria, certificado deuda, convocatoria, burofax, fotocopias, correo | junta extraordinària, certificat de deute, convocatòria, burofax, fotocòpies, correu | ud | C, H, K (trade) |
| 28 | INSURANCE | Community insurance | seguro, póliza, prima, recibo, siniestro, franquicia | assegurança, pòlissa, prima, rebut, sinistre, franquícia | any | C (policy), H, K (trade) |
| 29 | CLEANING | Cleaning | limpieza, escalera, portal, cristales | neteja, escala, portal, vidres | mes / h | C, H, K (trade) |
| 30 | ELECTRICITY | Electricity utility | electricidad, luz, kWh, potencia, término fijo | electricitat, llum, kWh, potència, terme fix | mes / kWh | H (benchmark on kWh and tariff, no indexation) |
| 31 | WATER_UTIL | Water utility | agua, m3, canon, consumo | aigua, m3, cànon, consum | m3 / mes | H |
| 32 | CAE_PRL | Contractor coordination / risk prevention | coordinación actividades empresariales, CAE, PRL, prevención riesgos, plataforma | coordinació d'activitats empresarials, CAE, PRL, prevenció de riscos | any | C, H, K (trade) |
| 33 | LEGAL | Legal and notarial | abogado, procurador, demanda, reclamación, morosos, notaría, registro | advocat, procurador, demanda, reclamació, morosos, notaria, registre | h / ud | C, H |
| 34 | BANK | Bank fees and loan service | comisión, mantenimiento cuenta, transferencia, préstamo, interés, amortización, aval | comissió, manteniment de compte, transferència, préstec, interès, amortització, aval | mes / % | C (loan contract), H |
| 35 | WASTE | Waste and containers | contenedor, escombros, saca, gestión residuos, vertedero | contenidor, runa, saca, gestió de residus, abocador | ud / m3 | C, K (trade) |
| 36 | PEST | Pest control | desinsectación, desratización, plagas | desinsectació, desratització, plagues | ud / any | C, H |
| 37 | FIRE | Fire safety | extintor, retimbrado, BIE, señalización | extintor, retimbrat, BIE, senyalització | ud / any | C, H |
| 38 | TELECOM | Aerial and telecoms | antena, TDT, amplificador, fibra, ICT | antena, TDT, amplificador, fibra, ICT | ud | C, H |
| 39 | GAS | Gas installation | gas, revisión, instalación receptora | gas, revisió, instal·lació receptora | ud / any | C, H |
| 40 | FUND_RESERVE | Reserve fund | fondo de reserva, dotación | fons de reserva, dotació | any | B (553-6 ≥ 5% of ordinary budget) |
| 41 | DERRAMA | Extraordinary contribution | derrama, cuota extraordinaria, aportación obras | derrama, quota extraordinària, aportació obres | unit·mes | B (resolution; expected via D5/D5b) |
| 42 | MISC | Unclassified | varios, otros, imprevistos, material, ferretería | altres, imprevistos, material, ferreteria | – | none (review queue) |
| 43 | ASBESTOS | Asbestos removal (added after review) | amianto, uralita, fibrocemento, desamiantado, plan de trabajo | amiant, uralita, fibrociment, desamiantat, pla de treball | ml / m2 / ud | C, K (trade); registry check under G5/G6 |

Notes:

- `WINDOWS`, `ENTRANCE_DOOR` and `INTERCOM` lines are checked for `element_scope` because the same
  words describe private-unit works.
- `ELEV_INSTALL`, `ELEV_CIVIL` and `STAIR_REHAB` are `non_benchmarkable` in v1: there is no
  comparable reference for a 6–7-stop lift in a protected pre-1965 stairwell (see
  `benchmark-sources.md` §3).
- `ADMIN_FEE` is benchmarked in €/unit/month; research packs disagree on the Barcelona range, so it
  can only reach severity 1–2.
- Index basis per category: works and materials → BEDEC edition variation (fallback INE materials
  index); labour-heavy services (cleaning, administration) → IPC Catalonia; insurance → IPC + 3–5
  points (estimate); energy → no indexation.

## 2. Quantity-extraction patterns

Applied to line descriptions, quantity/unit columns and headers of quotes, certifications and
invoices. Matching is case- and accent-insensitive. Each match stores the raw token in the
`evidence.quote` of the line.

| Pattern | Regex sketch (ES/CA) | Meaning | Handling |
|---|---|---|---|
| m2 | `\b(m2\|m²\|metros? cuadrados?\|metres? quadrats?)\b` | square metres | unit = m2 |
| ml | `\b(ml\|m\.?l\.?\|metros? lineales?\|metres? lineals?)\b` | linear metres | unit = ml |
| ud | `\b(ud\|uds\|u\.\|unidad(es)?\|unitat(s)?)\b` | units | unit = ud |
| pa | `\b(p\.?a\.?\|partida alzada\|partida alçada\|a justificar)\b` | lump sum | `es_partida_alzada = true`; a large lump sum (> 10% of contract) is itself a review item under A3/C9 |
| h | `\b(h\|hora(s)?\|hores)\b` | hours | unit = h |
| mes | `\b(mes\|meses\|mesos\|mensual\|mensualitat)\b` | months | unit = mes; recurring-service candidate |
| % | `(\d+[.,]?\d*)\s*%` | percentage (fees, retention, VAT, GG/BI) | attach to the neighbouring label |
| PEM | `\b(PEM\|presupuesto de ejecuci[oó]n material\|pressupost d'execuci[oó] material)\b` | material execution budget | `pem`; anchor for A9/G4 |
| PEC | `\b(PEC\|presupuesto de (ejecuci[oó]n por )?contrata\|pressupost (d'execuci[oó] )?per contracta)\b` | contract budget (PEM + GG + BI) | `presupuesto_contrata_sin_iva`; expected ≈ PEM × 1.19 |
| GG | `\b(GG\|gastos generales\|despeses generals)\b` | general expenses (public-works convention 13%) | `gastos_generales.pct/importe` |
| BI | `\b(BI\|beneficio industrial\|benefici industrial)\b` | industrial profit (convention 6%) | `beneficio_industrial.pct/importe` |
| certificación nº | `\b(certificaci[oó]n?\s*(n[ºo°]\|num\.?\|número)\s*\d+\|certificaci[oó]\s*(núm\.?\|n[ºo°])\s*\d+)\b` | certification number | `numero_certificacion`; links to milestones |
| a cuenta | `\b(a cuenta\|anticipo\|a compte\|bestreta\|acompte)\b` | advance payment | `is_advance = true`; D4 tolerance; A4 advances |
| retención | `\b(retenci[oó]n?\s*(de garant[ií]a)?\|retenci[oó]\s*(de garantia)?)\b` followed by `%` or amount | retention held | `retencion_garantia.pct/importe`; IRPF retention distinguished by the label `IRPF` |
| garantía | `\b(garant[ií]a\|garantia)\b` with months or % | guarantee term or retention | `garantia_meses` or retention |
| IVA rate | `\bIVA\s*(\d{1,2})\s*%` | VAT rate | `tipo_iva_pct`; must be in {0, 4, 10, 21} |
| Materials clause | `(coste de los materiales\|cost dels materials).{0,40}(40\s*%\|no supera)` | 40%-materials statement | `mencion_materiales_40 = true` (C2) |

Quantities written as `1.234,56` are normalised to `1234.56`; a quantity without a recognised unit is
stored with `unidad = null` and the line cannot enter the BENCHMARK layer.
