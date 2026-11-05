# Regesta · manual de uso

Tu archivo genealógico, buscable y descrito. Corre en tu propio servidor y
**nunca toca tus ficheros originales**: solo los lee.

> **Aviso.** Este manual describe la versión anterior, con la interfaz en
> español. La aplicación está ahora en inglés, así que los nombres de los
> botones y de las variables de configuración que aquí se citan han
> cambiado: `REGESTA_SONDEO` es ahora `REGESTA_POLLING`,
> `npm run indexar` es `npm run index`, y así con el resto. Lo que explica
> —cómo se cataloga, cómo se marca una partida, cómo se lee una letra
> difícil— sigue siendo válido.
>
> El manual al día está en [manual.md](manual.md), en inglés.

---

## Índice

1. [Lo primero: las tres reglas](#lo-primero-las-tres-reglas)
2. [Pantalla de inicio](#pantalla-de-inicio)
3. [Buscar](#buscar)
4. [El explorador lateral](#el-explorador-lateral)
5. [El visor de documentos](#el-visor-de-documentos)
6. [Leer manuscritos difíciles](#leer-manuscritos-difíciles)
7. [El cuadro de clasificación](#el-cuadro-de-clasificación)
8. [Describir un documento](#describir-un-documento)
9. [Etiquetas](#etiquetas)
10. [Revisar las fichas propuestas](#revisar-las-fichas-propuestas)
11. [Qué falta por encontrar](#qué-falta-por-encontrar)
12. [Duplicados](#duplicados)
13. [Gramps](#gramps)
14. [Añadir documentos nuevos](#añadir-documentos-nuevos)
15. [Cambiar la carpeta indexada](#cambiar-la-carpeta-indexada)
16. [Copias de seguridad](#copias-de-seguridad)
17. [Atajos de teclado](#atajos-de-teclado)
18. [Si algo va mal](#si-algo-va-mal)

---

## Lo primero: las tres reglas

**1. Tus documentos no se tocan.** La carpeta se monta en modo solo lectura.
Regesta no mueve, no renombra y no borra nada. No es una promesa del
programa: es el sistema operativo quien se lo impide.

**2. Gramps no se modifica.** Regesta copia tu árbol y consulta la copia.
Puedes tener Gramps abierto a la vez sin ningún riesgo.

**3. Lo que describes vive aparte.** Tu trabajo de catalogación está en un solo
fichero (`regesta.db`). Copiarlo es toda tu copia de seguridad.

---

## Pantalla de inicio

Lo primero que ves al abrir `http://tu-nas:8080`.

| Bloque | Para qué |
|---|---|
| **Carpeta indexada** | Qué carpeta se está leyendo y cuántos documentos hay |
| **Vigilancia** | Si detecta automáticamente lo nuevo, y cuándo fue el último cambio |
| **Árbol de Gramps** | Conectarlo o refrescar su copia |
| **Cifras** | Total de documentos, años cubiertos, fichas por revisar, duplicados |
| **Por tipo de acto** | Bautismos, matrimonios, defunciones… Pulsa uno para filtrar |
| **Por formato** | Imágenes, PDF, texto, Word. Pulsa uno para filtrar |
| **Últimos documentos** | Los mejor catalogados, para entrar directo |

---

## Buscar

La caja de arriba busca **en dos sitios a la vez**: el nombre del fichero y el
texto que hay dentro de los documentos.

### Lo que puedes escribir

| Escribes | Encuentra |
|---|---|
| `isabel` | También los que dicen «Ysabel» |
| `burlo` | También «Burló» — los acentos dan igual |
| `fernandez` | También «Fernández» |
| `escribano` | Documentos que contienen esa palabra **dentro** |
| `"ante mi dicho escribano"` | Esa frase exacta, literal |
| `juan AND aledo` | Los que contienen ambas palabras |

> **Las grafías antiguas se resuelven solas.** `YSABEL`/`ISABEL`,
> `JUSEPA`/`JOSEFA`, `XIMENEZ`/`JIMENEZ`, `DEL PESSO`/`DEL PESO`. No hace falta
> que aciertes con la ortografía del escribano.

### Los filtros

Sobre la lista de resultados:

- **Formato** — imágenes, PDF, texto, Word
- **Por página** — 30, 60, 120, 240 o *todos*. Se recuerda entre sesiones

### La vista previa

Pasa el ratón por encima de una miniatura sin pulsar. Te muestra lo que no cabe
en la tarjeta: el nombre completo, el segundo cónyuge, de qué carpeta viene, el
tamaño, si hay copias idénticas en otro sitio, y —si es un texto o un Word— las
primeras líneas de su contenido.

Si has buscado algo, la vista previa enseña **el fragmento donde aparece**, con
la palabra resaltada.

---

## El explorador lateral

El panel de la izquierda recorre el archivo de tres formas. Pulsa una rama para
ver lo que contiene.

**Carpetas** — tu estructura real del NAS. El número es acumulado: incluye lo
que hay en las subcarpetas.

**Actos** — bautismos, matrimonios, defunciones… y dentro, por siglo.

**Etiquetas** — tus propias marcas.

### Manejarlo

- La **flecha ▶** abre y cierra una rama sin cambiar la búsqueda
- Pasa el ratón por un nombre largo y verás el completo
- **Arrastra el borde derecho** para ensancharlo (o flechas ← → con el teclado;
  doble clic lo devuelve a su ancho original)
- La **flecha ‹** de arriba lo pliega; la pestaña **›** lo devuelve. También la
  tecla **E**

---

## El visor de documentos

Pulsa cualquier miniatura.

| Formato | Qué hace |
|---|---|
| Imágenes | Zoom, arrastre y herramientas de lectura |
| PDF | Se dibuja página a página, con zoom y arrastre |
| Texto | Se muestra con los acentos correctos |
| Word (.docx) | Se convierte conservando párrafos, listas y tablas |
| Otros | Ofrece descargar el original |

### Moverte

- **Arrastra** con el ratón para recorrer la imagen (el cursor es una mano)
- **Rueda** para acercar y alejar sobre el punto que señalas
- **Doble clic** alterna entre folio completo y tamaño original
- **← →** pasan al documento anterior y siguiente de la lista
- **‹** (arriba a la izquierda) vuelve al documento del que viniste

### Buscar dentro del documento

Pulsa **Buscar** o la tecla **F**. Escribe, y **Intro** te lleva de una
coincidencia a la siguiente.

> Si llegaste desde una búsqueda, el visor se abre **ya en la primera
> coincidencia**, con el término puesto. No tienes que buscarlo otra vez.

---

## Leer manuscritos difíciles

Pulsa **Ajustes** (o la tecla **A**) con una imagen abierta.

### El atajo que resuelve el 90 % de los casos

El botón **Lectura** (tecla **L**) aplica de golpe: escala de grises, contraste
alto y negativo. En un folio con tinta desvaída sobre papel amarillento, la
tinta clara sobre fondo oscuro se lee mucho mejor.

### Los controles

| Control | Cuándo usarlo |
|---|---|
| **Contraste** | Tinta pálida sobre papel claro |
| **Luminosidad** | Foto demasiado oscura o quemada |
| **Saturación** | Quitar la dominante de color de la iluminación |
| **Sepia** | Suavizar un escaneo demasiado frío |
| **Nitidez** | Realzar los trazos finos |
| **Umbral** | Deja solo tinta y papel, en blanco y negro puro |
| **Negativo** | Invierte: tinta clara sobre fondo oscuro |
| **Grises** | Quita el color del papel |
| **↺ ↻** | Girar folios escaneados de lado |
| **⇋** | Espejo, para leer tinta traspasada del reverso |

> **Sobre el umbral:** calcula un corte distinto para cada zona de la imagen,
> así que funciona aunque media página esté en sombra. Tarda un par de segundos
> porque analiza la imagen entera.

Los ajustes **se reinician con cada documento**, para que un contraste extremo
útil en un folio no estropee la lectura del siguiente. La tecla **R** los
restaura.

### Marcar una partida dentro del folio

Un folio suele contener cinco o seis partidas. Pulsa **Marcar partida** (tecla
**M**) y dibuja un rectángulo sobre la que te interesa. Se abre un panel para
describirla.

La marca se queda ahí: la próxima vez que abras el documento no tendrás que
buscar esa partida otra vez. Para volver a su panel, pulsa en la etiqueta del
recuadro.

#### Qué se anota de cada partida

| Campo | Qué poner |
|---|---|
| **Tipo de acto** | Bautismo, matrimonio, defunción… |
| **Fecha** y **Folio** | Los de esa partida, no los del documento entero |
| **Lugar** | Ver más abajo: se normaliza solo |
| **Resumen** y **Transcripción** | De esa partida en concreto |

Todo se guarda solo al dejar de escribir.

#### Quién sale en la partida

Debajo, en **Quién sale aquí**, se anota a cada persona con **qué papel** tuvo
y **con qué certeza** lo sabes.

Escribe el nombre y elige el papel —bautizado, padre, madrina, testigo…— y la
certeza:

| Certeza | Cuándo |
|---|---|
| **Segura** | El documento lo dice con claridad |
| **Probable** | Encaja, pero no está escrito |
| **Dudosa** | Es una hipótesis de trabajo |

Las probables y las dudosas se ven **con fondo distinto**, para que una
conjetura no acabe leyéndose como un hecho dentro de cinco años.

> **Si la persona está en tu árbol de Gramps**, elígela de las sugerencias: el
> vínculo queda enlazado a su identificador. Si no lo está —un padrino, un
> testigo que no vas a meter en el árbol—, escribe el nombre y se guarda solo
> aquí. No hace falta ensuciar Gramps para anotar a un testigo.

Si escribes un nombre que ya está en tu archivo con otra grafía, se unen solos
y te avisa: «Isabel Jimenez» se reconoce como la «Ysabel Ximenez» que anotaste
en otra partida. La grafía del documento se guarda como variante, así que no se
pierde cómo lo escribió el escribano.

#### Lugares

El campo **Lugar** sugiere los que ya has usado. Si escribes uno nuevo, se crea
solo; si escribes uno que ya existe con otras mayúsculas o tildes, se reconoce
y no se duplica.

Así «Ayora», «AYORA» y «Villa de Ayora» acaban siendo un solo lugar en la
exportación, en vez de tres filas que nadie puede cruzar.

---

## El cuadro de clasificación

Pestaña **Cuadro**, en la barra de arriba.

Se sembró a partir de tus carpetas del NAS, pero **es tuyo a partir de ahí**:
puedes crear los fondos y series que tenga de verdad tu archivo, aunque no se
parezcan a cómo están las carpetas en el disco.

| Qué | Cómo |
|---|---|
| Crear un fondo | Botón **+ Fondo nuevo**, arriba |
| Crear algo dentro | Selecciona una unidad y pulsa **+ Unidad dentro** |
| Describirla | Se abre su ficha a la derecha; se guarda sola |
| Moverla | Desplegable **Depende de**, al final de la ficha |
| Ver lo que cuelga | Botón **Ver sus N documentos** |

La ficha sigue **ISAD(G)**: título, nivel, signatura, fechas extremas, volumen,
productor, alcance y contenido, y —plegados— historia institucional, acceso,
soporte y conservación.

> **Borrar una unidad no borra ningún documento.** Lo que colgaba de ella,
> documentos y unidades, sube al nivel de arriba. Te lo dice antes de hacerlo.

Los niveles van de fondo a unidad documental, y al crear algo dentro se propone
el que suele tocar: dentro de un fondo, una sección; dentro de una sección, una
serie.

---

## Describir un documento

En el visor, pestaña **Describir**. Cada campo **se guarda solo** al dejar de
escribir (verás «Guardado»).

Los campos vienen **ya rellenos** con lo que se dedujo del nombre del fichero,
así que normalmente solo tienes que corregir.

| Campo | Qué poner |
|---|---|
| **Tipo de acto** | Bautismo, matrimonio, defunción… |
| **Personas** | Como figuran en el documento, separadas por `·` |
| **Fecha** | `1802`, `1802-05` o `1802-05-14` — lo que sepas |
| **Lugar** | Parroquia o localidad |
| **Folio** | `45v` |
| **Resumen** | De qué trata, en una línea |
| **Transcripción** | El texto literal, si lo has transcrito |

Plegado en **Contexto y conservación**: productor, signatura original, soporte
y estado de conservación.

> Lo que escribes **entra en la búsqueda**. Una regesta o una transcripción son
> justo lo que querrás encontrar más adelante.

### Procedencia

El desplegable **Procedencia** registra de dónde salió el documento: qué
archivo, qué visita. Puedes crear una nueva desde ahí mismo.

Es el dato que se pierde si no se anota en el momento: dentro de cinco años no
recordarás si aquel PDF vino de FamilySearch o del Archivo Diocesano.

---

## Etiquetas

Marcas tuyas para organizar el trabajo: «revisado», «pedir copia en el
archivo», «rama materna»…

**Crearlas:** en el explorador, pestaña *Etiquetas*, escribe el nombre y pulsa
**+**. O desde la ficha de un documento con el botón **+**, que la crea y la
aplica de una vez.

**Ponerlas y quitarlas:** en la ficha del documento, pulsando la etiqueta.

**Filtrar:** pulsa una etiqueta en el explorador.

**Borrarlas:** pasa el ratón sobre la etiqueta en el explorador y pulsa el aspa.
Te dirá a cuántos documentos afecta. Los documentos no se borran.

---

## Revisar las fichas propuestas

Pestaña **Revisar**. Al indexar, Regesta lee el nombre de cada fichero y
propone una ficha. La mayoría son correctas, así que revisarlas es sobre todo
confirmar.

Verás el documento a la izquierda y la ficha propuesta a la derecha:

| Tecla | Acción |
|---|---|
| **Intro** | Aceptar la ficha tal cual |
| **C** | Corregir — abre el visor con el formulario |
| **N** | No es un acto documental (descartar) |
| **→** | Saltar sin decidir |
| **V** | Ver el documento completo |

La cola va **de lo más fiable a lo más dudoso**, así que confirmarás muchas
seguidas antes de llegar a las que exigen pensar.

> **Atajo:** el botón **«Aceptar todas las fiables de golpe»** valida de una vez
> todas las bien leídas. Podrás corregir cualquiera después.

---

## Qué falta por encontrar

Pestaña **Qué falta**. Cruza tu árbol de Gramps con los documentos que tienes y
te dice **qué hechos no tienen ningún papel que los respalde**.

Es la única pantalla que no mira lo que ya tienes sino lo que falta: un plan de
trabajo para la próxima visita al archivo.

Cada línea dice de quién, qué acto, qué año y qué lugar. El botón **Buscar** lo
busca en tu archivo, por si ya lo tienes indexado sin enlazar.

**Requiere Gramps conectado y documentos enlazados a personas.** Cuantos más
enlaces, más útil.

> No se listan los hechos de los últimos 25 años: los archivos aplican plazos
> de reserva y esas partidas no se pueden pedir todavía.

---

## Duplicados

Pestaña **Duplicados**. Encuentra ficheros con **contenido idéntico**, aunque
se llamen distinto y estén en carpetas diferentes.

Útil cuando has descargado el mismo documento dos veces con meses de
diferencia. Regesta no borra nada: solo te los enseña.

---

## Gramps

Regesta **lee** tu árbol para mostrar contexto junto a cada documento. Nunca
escribe en él.

### Conectarlo

En *Inicio → Árbol de Gramps*, indica la ruta de tu `sqlite.db`. En el NAS suele
ser algo como:

```
/gramps/grampsdb/<identificador>/sqlite.db
```

Regesta copia ese fichero y consulta la copia, así que **puedes tener Gramps
abierto a la vez**. El botón *Actualizar copia* la refresca cuando cambies algo
en el árbol.

### Enlazar un documento con una persona

En la ficha, sección **Persona en Gramps**: escribe un nombre y elige. Los
resultados muestran los años (`1871–1952`) para distinguir homónimos, que en una
familia son la norma.

Una vez enlazado verás:

- Sus **eventos** con fecha y lugar
- **Quién más participa** en cada uno, con su papel
- Las **notas** que escribiste en Gramps
- Las **citas** ya registradas
- **Todos los documentos** que has enlazado a esa persona — pulsa para saltar

El enlace se guarda en Regesta, nunca en Gramps.

---

## Añadir documentos nuevos

**No tienes que hacer nada.** Copia el fichero a la carpeta del NAS y en unos
segundos aparece en la aplicación, con su miniatura y su texto ya buscable.

Regesta vigila la carpeta y además la repasa entera al arrancar y cada 6 horas.

Si has copiado algo desde otro equipo y no aparece, pulsa **Buscar novedades**
en la pantalla de inicio.

---

## Cambiar la carpeta indexada

En *Inicio → Carpeta indexada → Cambiar*.

El desplegable ofrece las carpetas que el contenedor tiene montadas. Para dar
acceso a una carpeta nueva hay que montarla en el `docker-compose.yml` y
reiniciar el contenedor:

```yaml
volumes:
  - /volume1/TU_ARCHIVO:/documentos:ro
  - /volume1/otra-coleccion:/documentos-2:ro
```

Al cambiar, lo indexado de la carpeta anterior se marca como ausente pero **no
se borra**. Si vuelves a ella, tu descripción sigue ahí.

---

## Copias de seguridad

Todo tu trabajo está en la carpeta de datos del contenedor
(`/volume1/docker/regesta/datos` o donde la hayas puesto):

- `regesta.db` — **tu catalogación entera**. Es lo importante
- `exportacion/` — la copia legible (ver abajo)
- `miniaturas/` — se pueden regenerar, no es crítico
- `gramps-copia.db` — copia de tu árbol, se puede rehacer

**Copia `regesta.db` de vez en cuando.** Tus documentos originales ya están a
salvo en el NAS; lo que no se puede reconstruir es la descripción.

### Copia legible

En *Inicio → Copia legible de tu catalogación → Exportar ahora*.

Vuelca todo lo que has descrito a formatos que se leen **sin Regesta**, en la
carpeta `exportacion/`:

| Fichero | Qué contiene |
|---|---|
| `documentos.csv` | Un documento por fila, con toda su descripción |
| `asientos.csv` | Las partidas marcadas dentro de los folios |
| `personas-en-partidas.csv` | Quién sale en cada partida, con su papel y su certeza |
| `lugares.csv` | Los lugares normalizados y sus otras grafías |
| `etiquetas.csv` | Qué etiqueta lleva cada documento |
| `procedencias.csv` | De dónde salió cada documento |
| `cuadro-de-clasificacion.csv` | La jerarquía de fondos, secciones y series |
| `documentos/*.txt` | Una ficha de texto por documento descrito |
| `LEEME.txt` | Explicación de todo lo anterior |

Los CSV usan punto y coma, que es lo que espera Excel en español, así que se
abren con doble clic. Las fichas de texto llevan la transcripción completa, que
en una celda de hoja de cálculo se lee mal.

`personas-en-partidas.csv` es el que convierte el archivo en algo cruzable: una
fila por persona y partida, con el papel, la certeza, la fecha y el lugar. Con
él puedes preguntar en cualquier hoja de cálculo en cuántos bautismos fue
padrino la misma persona, o qué atribuciones dudosas te quedan por confirmar.

También puedes descargar una tabla suelta a tu equipo con los enlaces de debajo
del botón.

> **Por qué importa:** si dentro de diez años esta aplicación no arranca, tu
> trabajo de catalogación sigue siendo legible. Los documentos originales no se
> copian aquí: siguen donde siempre, en tu carpeta del NAS.

---

## Atajos de teclado

### En el visor

| Tecla | Acción |
|---|---|
| `←` `→` | Documento anterior y siguiente |
| `+` `−` | Acercar y alejar |
| `0` | Ajustar a la ventana |
| `F` | Buscar dentro del documento |
| `Intro` | Siguiente coincidencia (`Mayús+Intro`: anterior) |
| `L` | Modo lectura |
| `I` | Invertir |
| `A` | Panel de ajustes |
| `M` | Marcar una partida |
| `R` | Restaurar los ajustes |
| `Retroceso` | Volver al documento anterior |
| `Esc` | Cerrar |

### En la revisión

| Tecla | Acción |
|---|---|
| `Intro` | Aceptar |
| `C` | Corregir |
| `N` | No es un acto |
| `→` | Saltar |
| `V` | Ver el documento |

### General

| Tecla | Acción |
|---|---|
| `E` | Plegar o desplegar el explorador |

---

## Si algo va mal

**No aparece un documento que acabo de copiar**
Pulsa *Buscar novedades* en Inicio. Si sigue sin aparecer, es posible que los
avisos del sistema no lleguen a través de la red: añade `REGESTA_POLLING: "1"`
al `docker-compose.yml` y reinicia.

**Los duplicados y las fichas por revisar no paran de crecer**
Las versiones anteriores indexaban las copias de la carpeta `#snapshot` de
Synology, un juego más con cada instantánea. Vuelve a compilar la imagen: en el
primer arranque Regesta quita esas copias y anota cuántas en el registro, y
conserva las que lleven trabajo tuyo.

**El contenedor sale como "unhealthy" y el registro se llena de `ENOSPC`**
El sistema se ha quedado sin avisos de ficheros. Regesta omite las carpetas
`#snapshot`, `@eaDir` y `#recycle` de Synology y, si aun así se agotan, deja de
vigilar y confía en el repaso periódico. Si sigues viéndolo, usas una
versión anterior: vuelve a compilar la imagen (lo explica el README).

**La búsqueda no encuentra texto dentro de un PDF**
Puede ser un escaneo sin capa de texto: una imagen dentro de un PDF. Eso
necesitaría OCR, que no está implementado.

**Un documento sale con un año imposible**
El año se leyó de un número del nombre del fichero que no era una fecha (una
signatura, un número de página). Sale tachado y marcado. Corrígelo en la
pestaña *Describir*.

**Gramps dice que la copia no se puede leer**
Comprueba la ruta: debe apuntar al `sqlite.db`, no a la carpeta. Y que esté
montada en el `docker-compose.yml`.

**He borrado algo sin querer**
Los documentos originales nunca se borran: Regesta no puede tocarlos. Si has
borrado una etiqueta o un recorte, tendrás que rehacerlo. Restaura una copia de
`regesta.db` si tenías una.
