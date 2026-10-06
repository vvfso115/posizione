/* =====================================================================
   locator.js — acquisizione e invio della posizione
   =====================================================================
   Parametri dell'indirizzo:
     id       identificativo dell'evento, composto dal portale
              (es. 001111_26_BL per l'intervento 1111 del 2026)
     comando  nome del comando, mostrato in testata
     lingua   it | en | fr | de | es | ro | sq | uk | zh | ar

   La posizione viene scritta su un foglio Google tramite uno script
   pubblicato come applicazione web (vedi IMPOSTAZIONI qui sotto e le
   istruzioni in LEGGIMI.md). La sala operativa legge il foglio.

   Scelte volute:
   - nessuna libreria esterna e nessun carattere scaricato: la pagina si
     apre in fretta anche con una linea debole;
   - l'invio usa `no-cors`, perché Apps Script non restituisce le
     intestazioni CORS: non si può leggere la risposta, quindi l'esito
     dell'invio non è mai dato per certo e le coordinate restano sempre
     visibili da leggere al telefono;
   - un secondo tentativo con `sendBeacon` se il primo fallisce;
   - la precisione viene detta all'utente: cinquanta metri in montagna
     possono voler dire il versante sbagliato.
   ===================================================================== */

/* ========================= IMPOSTAZIONI ========================= */
/* Incollare qui l'indirizzo dell'applicazione web di Apps Script,
   quello che finisce con /exec — vedi LEGGIMI.md */
var URL_RACCOLTA = "https://script.google.com/macros/s/AKfycbzS95xouM3fBGt_i9AWWesCXEEWnjbfDww4wtJPJx4JzDmivjsa_slRjqxaF2ZjUbdP/exec";

/* Chiave condivisa, se impostata anche nello script lato Google:
   evita che qualcuno scriva sul foglio conoscendo solo l'indirizzo. */
var CHIAVE = "ArKt2}52g[chJ8^j%z2k7B";
/* =============================================================== */

(function () {
  'use strict';

  var par = new URLSearchParams(location.search);
  var ID = (par.get('id') || '').trim();
  var COMANDO = (par.get('comando') || 'Belluno').trim();
  var LINGUA = (par.get('lingua') || 'it').trim().toLowerCase();

  var T = window.TRADUZIONI[LINGUA] || window.TRADUZIONI.it;
  if (!window.TRADUZIONI[LINGUA]) LINGUA = 'it';

  var posizione = null;      /* la lettura migliore finora, per il video */
  var letture = [];          /* tutte le letture fatte, in ordine */
  var inviate = 0;           /* quante sono partite verso il foglio */
  var inviata = false;
  var tentativo = 0;         /* quale tentativo stiamo facendo */
  var TENTATIVI = 3;         /* il GPS migliora con qualche secondo in più */

  /* ------------------------------------------------------ interfaccia */
  function testo(id, valore) {
    var el = document.getElementById(id);
    if (el) el.textContent = valore;
  }

  function applicaLingua() {
    document.documentElement.lang = LINGUA;
    document.body.setAttribute('dir', T.rtl ? 'rtl' : 'ltr');
    document.title = T.intestazione + ' — ' + T.titolo;

    testo('t-titolo', T.titolo);
    testo('t-comando', T.comando.replace('{comando}', COMANDO));
    testo('t-intestazione', T.intestazione);
    testo('t-spiegazione', T.spiegazione);
    testo('t-rileva', T.rileva);
    testo('t-mappa', T.mappa);
    testo('t-riprova', T.riprova);
    testo('t-emergenza-su', T.emergenza_su);
    testo('t-emergenza-giu', T.emergenza_giu);
    testo('t-aiuto-titolo', T.aiuto_titolo);
    testo('t-aiuto-1', T.aiuto_1);
    testo('t-aiuto-2', T.aiuto_2);
    testo('t-aiuto-3', T.aiuto_3);
    testo('t-aiuto-4', T.aiuto_4);
    testo('t-piede', T.piede);
    testo('t-privacy', T.privacy);

    var box = document.getElementById('idEvento');
    if (ID) box.textContent = 'ID ' + ID;
    else box.classList.add('nascosto');
  }

  function stato(tipo, messaggio, segno) {
    var el = document.getElementById('stato');
    el.className = 'stato ' + tipo;
    document.getElementById('statoSegno').textContent =
      segno || (tipo === 'ok' ? '✅' : tipo === 'errore' ? '⚠️' : '📍');
    document.getElementById('statoTesto').textContent = messaggio;
  }

  function attesa(on) {
    document.getElementById('btnRileva').disabled = on;
    document.getElementById('rotella').classList.toggle('nascosto', !on);
  }

  function costruisciLingue() {
    var box = document.getElementById('lingue');
    Object.keys(window.TRADUZIONI).forEach(function (codice) {
      var b = document.createElement('button');
      b.textContent = window.TRADUZIONI[codice].nome;
      if (codice === LINGUA) b.className = 'on';
      b.onclick = function () {
        par.set('lingua', codice);
        location.search = par.toString();
      };
      box.appendChild(b);
    });
  }

  /* ------------------------------------------------------- posizione */
  function rileva(primo) {
    if (!navigator.geolocation) {
      stato('errore', T.non_supportato);
      return;
    }
    if (primo !== false) {
      tentativo = 0;
      posizione = null;
      letture = [];
      inviate = 0;
      inviata = false;
    }
    tentativo++;
    attesa(true);
    stato('attesa', testoTentativo(), '🛰️');
    document.getElementById('btnRiprova').classList.add('nascosto');

    navigator.geolocation.getCurrentPosition(riuscito, fallito, {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 0,
    });
  }

  function testoTentativo() {
    var base = T.rilevo;
    if (TENTATIVI > 1) {
      base += ' (' + (T.tentativo || 'tentativo {n} di {tot}')
        .replace('{n}', tentativo).replace('{tot}', TENTATIVI) + ')';
    }
    return base;
  }

  /* Il GPS si assesta in qualche secondo: la prima lettura è spesso la
     peggiore, a volte di chilometri. Si fanno quindi tre letture e si
     inviano TUTTE, una per una, appena arrivano.

     Inviarle tutte e subito, invece di tenere solo la migliore e mandarla
     alla fine, serve a due cose: la sala operativa vede qualcosa già dopo
     pochi secondi — che con una persona in difficoltà è ciò che conta — e
     le tre letture insieme raccontano se chi chiama è fermo o si sta
     spostando, che una sola non direbbe. A video resta mostrata la
     migliore, perché è quella che il cittadino può dettare al telefono. */
  function riuscito(pos) {
    var letta = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      precisione: Math.round(pos.coords.accuracy || 0),
      quota: pos.coords.altitude != null ? Math.round(pos.coords.altitude) : null,
      momento: new Date().toISOString(),
      tentativo: tentativo,
    };
    letture.push(letta);

    /* Parte subito, da sé: non si aspetta la lettura successiva */
    invia(letta);

    /* precisione 0 significa "non dichiarata": non è una lettura perfetta */
    var migliore = !posizione ||
      (letta.precisione > 0 && (posizione.precisione === 0 ||
                                letta.precisione < posizione.precisione));
    if (migliore) posizione = letta;

    mostra(posizione);

    if (tentativo < TENTATIVI) {
      stato('attesa', testoTentativo(), '🛰️');
      setTimeout(function () { rileva(false); }, 2500);
      return;
    }

    attesa(false);
    document.getElementById('t-rileva').textContent = T.riprova;
    conclusione();
  }


  /* Cosa si dice a fine giro. L'esito di un invio verso Apps Script non è
     mai certo (vedi invia()), quindi si parla di posizioni «inviate», non
     di posizioni «ricevute»: la conferma vera la ha la sala operativa. */
  function conclusione() {
    if (!URL_RACCOLTA) {
      stato('attesa', T.non_inviata, '📄');
      return;
    }
    if (!inviate) {
      stato('attesa', T.non_inviata, '📄');
      return;
    }
    inviata = true;
    if (inviate > 1 && T.inviate_n) {
      stato('ok', T.inviate_n.replace('{n}', inviate), '✅');
    } else {
      stato('ok', T.inviata, '✅');
    }
  }

  function mostra(p) {
    var coord = p.lat.toFixed(6) + ', ' + p.lon.toFixed(6);
    document.getElementById('coordinate').textContent = coord;

    var elPrec = document.getElementById('precisione');
    if (p.precisione > 0) {
      var modello = p.precisione > 100 ? T.precisione_scarsa : T.precisione;
      elPrec.textContent = modello.replace('{metri}', p.precisione);
    } else {
      elPrec.textContent = '';
    }
    document.getElementById('boxCoordinate').classList.remove('nascosto');

    var mappa = document.getElementById('btnMappa');
    mappa.href = 'https://maps.google.com/?q=' + p.lat.toFixed(6) + ',' + p.lon.toFixed(6);
    mappa.classList.remove('nascosto');
  }

  function fallito(e) {
    /* Il consenso negato non migliora ritentando: inutile insistere */
    var negato = e && e.code === 1;
    if (!negato && tentativo < TENTATIVI) {
      setTimeout(function () { rileva(false); }, 1500);
      return;
    }
    attesa(false);

    /* Le letture riuscite prima sono già partite: non si rimanda niente,
       si dice soltanto come è finita. */
    if (letture.length) {
      mostra(posizione);
      document.getElementById('t-rileva').textContent = T.riprova;
      conclusione();
      return;
    }

    var messaggio = T.non_disponibile;
    if (negato) messaggio = T.negato;
    else if (e && e.code === 3) messaggio = T.scaduto;
    stato('errore', messaggio);
    document.getElementById('btnRiprova').classList.remove('nascosto');
  }

  /* --------------------------------------------------------- invio */

  /* Invia UNA lettura. Viene chiamata una volta per lettura, quindi sul
     foglio compaiono tre righe con lo stesso ID evento: è voluto, ed è
     ciò che permette al portale di mostrarle tutte. */
  function invia(lettura) {
    if (!URL_RACCOLTA) {
      /* Non configurato: la posizione resta comunque leggibile a video,
         e si può dettare al telefono. */
      stato('attesa', T.non_inviata, '📄');
      return;
    }

    var dati = {
      id: ID,
      comando: COMANDO,
      lingua: LINGUA,
      lat: lettura.lat,
      lon: lettura.lon,
      precisione: lettura.precisione,
      quota: lettura.quota,
      momento: lettura.momento,
      tentativo: lettura.tentativo,
      agente: navigator.userAgent,
      chiave: CHIAVE,
    };

    var corpo = JSON.stringify(dati);

    /* Apps Script non risponde con le intestazioni CORS: l'invio funziona,
       ma la risposta non è leggibile. Si usa quindi `no-cors` e si
       considera riuscito ciò che parte senza errore di rete. */
    fetch(URL_RACCOLTA, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: corpo,
      keepalive: true,
    }).then(function () {
      inviate++;
      if (tentativo >= TENTATIVI) conclusione();
    }).catch(function () {
      /* Secondo tentativo: sendBeacon sopravvive anche se la pagina si
         chiude, cosa non rara quando si torna alla telefonata. */
      var ok = false;
      try {
        ok = navigator.sendBeacon(URL_RACCOLTA,
          new Blob([corpo], { type: 'text/plain;charset=utf-8' }));
      } catch (e) { ok = false; }
      if (ok) {
        inviate++;
        if (tentativo >= TENTATIVI) conclusione();
      } else if (!inviate) {
        stato('attesa', T.non_inviata, '📄');
      }
    });

    /* Rete molto lenta: dopo dodici secondi si dice comunque come stanno
       le cose, senza lasciare l'utente a fissare una rotella. */
    setTimeout(function () {
      if (!inviata && !inviate) stato('attesa', T.non_inviata, '📄');
    }, 12000);
  }

  /* --------------------------------------------------------- avvio */
  applicaLingua();
  costruisciLingue();
  document.getElementById('btnRileva').onclick = function () { rileva(true); };
  document.getElementById('btnRiprova').onclick = function () { rileva(true); };

  /* Molti telefoni mostrano la richiesta di consenso solo dopo un tocco:
     non si parte da soli, si aspetta che l'utente prema. */
})();
