/**
 * @file This is the window node module for the automatic tracing functionality
 * that supplies init and binding code for the PancakePainter window API.
 * Exports function returns a window control object that allows triggering on
 * init, show, and hide events.
 *
 * We have full access to globals loaded in the mainWindow as needed, just
 * reference them below.
 **/
 /*globals paper, $, path, app, mainWindow */

module.exports = function(context) {
  // Central window detail object returned for windows[autotrace] object.
  var autotrace = {
    settings: {},
    paper: {}, // PaperScope for auto trace preview
    source: '/home/techninja/web/pancake/testimages/rams.png',
    intermediary: path.join(app.getPath('temp'), 'pp_tempraster.png'),
    tracebmp: path.join(app.getPath('temp'), 'pp_tracesource.bmp'),
  };

  // Switch for detecting if a setting was changed by preset or by hand.
  // Avoids update thrashing cause by mass updates.
  var setByPreset = false;

  // Load the auto trace PaperScript (only when the canvas is ready).
  var autoTraceLoaded = false;
  function autoTraceLoad() {
    if (!autoTraceLoaded) {
      autoTraceLoaded = true;
      autotrace.paper = paper.PaperScript.load($('<script>').attr({
        type:"text/paperscript",
        src: "autotrace.ps.js",
        canvas: "autotrace-preview"
      })[0]);
    }
  }

  // Bind the window's settings inputs into a single object on change.
  function bindSettings() {
    setByPreset = true; // Ignore updates for initial bind.
    $('input, select', context).change(function() {
      // Save each setting based on name attribute.
      if (this.type === 'checkbox') {
        autotrace.settings[this.name] = $(this).prop('checked');
      } else {
        if (this.type === 'radio') {
          if ($(this).prop('checked')) {
            autotrace.settings[this.name] = $(this).val();
          }
        } else {
          autotrace.settings[this.name] = $(this).val();
        }
      }

      if (!setByPreset) {
        autotrace.paper.renderTraceImage()
          .then(autotrace.paper.renderTraceVector);
      }
    }).change(); // Trigger initial change to save data.

    setByPreset = false; // Ready for updates.
  }

  // Bind the buttons on the window.
  function bindButtons() {
    $('button', context).click(function() {
      switch(this.name) {
        case 'simple':
          break;

        case 'complex':
          break;

        case 'cancel':
          mainWindow.overlay.toggleWindow('autotrace', false);
          break;

        case 'import':
          // TODO: Import content into main paper context.
          break;

        case 'transparent-pick':
          // TODO: add colorpicker
          break;
      }
    });
  }

  // Init after build event.
  autotrace.init = function() {
    bindSettings();
    bindButtons();
  };

  // Window show event.
  autotrace.show = function() {
    autoTraceLoad();
    // Activate the trace preview paperscope.
    autotrace.paper.activate();

    // Init load and build the images
    autotrace.paper.loadTraceImage()
      .then(autotrace.paper.renderTraceImage)
      .then(autotrace.paper.renderTraceVector);
  };

  // Window hide event.
  autotrace.hide = function() {
    // Re-activate the default editor paperscope .
    paper.activate();
  };

  return autotrace;
};
