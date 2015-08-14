/**
 * @file This is the central application logic and window management src file.
 * This is the central render process main window JS, and has access to
 * the DOM and all node abilities.
 **/
"use strict";

// Libraries ==============================================---------------------
// Must use require syntax for including these libs because of node duality.
window.$ = window.jQuery = require('jquery');
window._ = require('underscore');
// GCODE renderer (initialized after paper is setup)
var gcRender = require('./gcode.js');

// Main Process ===========================================---------------------
// Include global main process connector objects for the renderer (this window).
var remote = require('remote');
var mainWindow = remote.getCurrentWindow();
$.i18n = window.i18n = remote.require('i18next');
var app = remote.require('app');
require('../menus/menu-init')(app); // Initialize the menus

// Bot specific configuration & state =====================---------------------
var scale = {};
var renderConfig = {
  flattenResolution: 15, // Flatten curve value (smaller value = more points)
  lineEndPreShutoff: 35, // Remaining line length threshold for pump shutoff
  startWait: 0.75, // Time to wait for batter flow
  endWait: 0.65, // Time to wait for batter flow
  printArea: { // Print area limitations (in MM)
    x: [42, 485],
    y: [0, 210]
  },
  version: app.getVersion() // Application version written to GCODE header
};

// Page loaded
$(function(){
   // After page load, wait for the griddle image to finish before initializing.
  $('#griddle').load(initEditor);

  // Apply element translation
  $('[data-i18n=""]').each(function() {
    var $node = $(this);

    if ($node.text().indexOf('.') > -1 && $node.attr('data-i18n') == "") {
      var key = $node.text();
      $node.attr('data-i18n', key);
      $node.text(i18n.t(key));
    }
  });

});

function initEditor() {
  var $griddle = $('#editor-wrapper img');
  var $editor = $('#editor');

  $griddle.aspect = 0.5390;
  $editor.aspect = 0.4717;
  $editor.pos = {
    left: 27,
    top: 24,
    right: 48,
    bottom: 52
  };

  var margin = [160, 100];

  // Set maximum work area render size
  $(window).on('resize', function(e){
    var win = [$(window).width(), $(window).height()];

    // Assume size to width
    $griddle.width(win[0] - margin[0]);
    $griddle.height((win[0] - margin[0]) * $griddle.aspect);


    // If too large, size to height
    if ($griddle.height() > win[1] - margin[1]) {
      $griddle.width((win[1] - margin[1]) / $griddle.aspect);
      $griddle.height((win[1] - margin[1]));
    }

    scale = {};
    scale.x = ($griddle.width()) / $griddle[0].naturalWidth;
    scale.y = ($griddle.height()) / $griddle[0].naturalHeight;

    scale = (scale.x < scale.y ? scale.x : scale.y);

    var off = $griddle.offset();
    $editor.css({
      top: off.top + (scale * $editor.pos.top),
      left: off.left + (scale * $editor.pos.left),
      width: $griddle.width() - ($editor.pos.right * scale),
      height: $griddle.height() - ($editor.pos.bottom * scale)
    });

    editorLoad(); // Load the editor (if it hasn't already been loaded)
    // This must happen after the very first resize, otherwise the canvas doesn't
    // have the correct dimensions for Paper to size to.
    $(mainWindow).trigger('move');

    updateFrosted();
  }).resize();
}

// Load the actual editor PaperScript (only when the canvas is ready).
var editorLoaded = false;
function editorLoad() {
  if (!editorLoaded) {
    editorLoaded = true;
    paper.PaperScript.load($('<script>').attr({
      type:"text/paperscript",
      src: "editor.ps.js",
      canvas: "editor"
    })[0]);
  }
}

// Trigger load init resize only after editor has called this function.
function editorLoadedInit() {
  $(window).resize();
  buildToolbar();
  buildColorPicker();
  bindControls();

  // Load the renderer once paper is ready
  renderConfig.paper = paper;
  gcRender = gcRender(renderConfig);
}

function buildToolbar() {
  var $t = $('<ul>').appendTo('#tools');

  _.each(paper.tools, function(tool, index){
    if (tool.key) {
      $t.append($('<li>').append(
        $('<img>').attr({
          src: 'images/icon-' + tool.key + '.png',
          title: i18n.t(tool.name),
          draggable: 'false'
        })
      ).click(function(){
        $('#tools li.active').removeClass('active');
        $(this).addClass('active');
        tool.activate();
        $('#editor').css('cursor', 'url("images/cursor-' + tool.key + '.png"), move');
      }));
    }
  });

  // Activate the first (default) tool.
  $t.find('li:first').click();
}

function buildColorPicker() {
  var $picker  = $('<div>').attr('id', 'picker');
  _.each(paper.pancakeShades, function(color, index) {
    $picker.append(
      $('<a>')
        .addClass('color' + index + (index === 0 ? ' active' : ''))
        .attr('href', '#')
        .attr('title', i18n.t('color.color' + index))
        .click(function(e){selectColor(index); e.preventDefault();})
        .css('background-color', color)
    );
  });

  var $color = $('<div>')
    .attr('id', 'color')
    .attr('title', i18n.t('color.title'))
    .css('background-color', paper.pancakeShades[0])
    .append($picker);

  $('#tools').append($color);
}

function selectColor(index) {
  paper.pancakeCurrentShade = index;
  $('#picker a.active').removeClass('active');
  $('#picker a.color' + index).addClass('active');
  $('#color').css('background-color', paper.pancakeShades[index]);

  if (paper.selectRect) {
    if (paper.selectRect.ppath) {
      paper.selectRect.ppath.strokeColor = paper.pancakeShades[index];
      paper.selectRect.ppath.data.color = index;
      paper.view.update();
    }
  }
}

function toggleExport(doShow) {
  if (typeof doShow === 'undefined') {
    doShow = !$('#overlay').is(':visible');
  }

  if (doShow) {
    $('#overlay').fadeIn('slow');
    paper.deselect();
    updateFrosted(function(){
      $('#export').fadeIn('slow');
    });
  } else {
    $('#overlay').fadeOut('slow');
    $('#export').fadeOut('slow');
  }
}

// When the page is done loading, all the controls in the page can be bound.
function bindControls() {
  // Export window
  $('#export button').click(function(e){
    switch ($(this).attr('class')) {
      case 'done':
        toggleExport();
        break;
      case 'start':
        $('textarea').val(gcRender());
        break;
    }
  });

  // Catch all keystrokes
  $(document).keyup(function(e){
    if (e.keyCode === 27) {
      toggleExport(false);
    }
  });

  // Callback/event for when any menu item is clicked
  app.menuClick = function(menu) {
    switch (menu) {
      case 'file.export':
        toggleExport(true);
        break;
      default:
        console.log(menu);
    }
  };
}

function updateFrosted(callback) {
  if ($('#overlay').is(':visible')) {
    html2canvas($("#non-overlay-wrapper")).then(function(canvas) {
      $("#frosted").remove();
      $("#overlay").append(canvas);
      $("#overlay canvas").attr('id', 'frosted');
      stackBlurCanvasRGB('frosted', 0, 0, $("#frosted").width(), $("#frosted").height(), 20);
      if (callback) callback();
    });
  }
}
