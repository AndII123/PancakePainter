/**
 * @file This is a helper include for adding various utility methods for paper.
 **/

module.exports = function(paper) {
  var utils = {};
  var _ = require('underscore');
  var canvasBuffer = require('electron-canvas-to-buffer');
  var fs = require('fs-plus');
  const ProgressPromise = require('progress-promise');

  utils = {
    /**
     * Offset a paper path a given amount, either in or out. Returns a reference
     * given to the output polygonal path created.
     *
     * @param {Path} inPath
     *   Paper Path object to be converted to polygon and offsetted.
     * @param {Number} amount
     *   The amount to offset by.
     * @param {Number} flattenResolution
     *   Resolution to flatten to polygons.
     * @param {Boolean} doReplace
     *   Optional, defaults to false. Pass true to replace the passed object.
     * @return {Path}
     *   Reference to the path object created, false if the output of the path
     *   resulted in the eradication of the path.
     */
    offsetPath: function(inPath, amount, flattenResolution, doReplace = false) {
      var ClipperLib = require('../libs/clipper');
      var scale = 100;
      if (!amount) amount = 0;

      // 1. Copy the input path & make it flatten to a polygon/multiple gons.
      // 2. Convert the polygon(s) points into the clipper array format.
      // 3. Delete the temp path.
      // 4. Run the paths array through the clipper offset.
      // 5. Output and descale the paths as single compound path.

      var p = inPath.clone();
      var paths = [];

      // Is this a compound path?
      try {
        if (p.children) {
          _.each(p.children, function(c, pathIndex) {
            if (c.segments.length <= 1 && c.closed) {
              c.closed = false;
            }
            c.flatten(flattenResolution);
            paths[pathIndex] = [];
            _.each(c.segments, function(s){
              paths[pathIndex].push({
                X: s.point.x,
                Y: s.point.y,
              });
            });
          });
        } else { // Single path
          paths[0] = [];
          p.flatten(flattenResolution);
          _.each(p.segments, function(s){
            paths[0].push({
              X: s.point.x,
              Y: s.point.y,
            });
          });
        }
      } catch(e) {
        console.error('Error flattening path for offset:', inPath.data.name, e);
        p.remove();
        return inPath;
      }

      // Get rid of our temporary poly path
      p.remove();

      ClipperLib.JS.ScaleUpPaths(paths, scale);
      // Possibly ClipperLib.Clipper.SimplifyPolygons() here
      // Possibly ClipperLib.Clipper.CleanPolygons() here

      // 0.1 should be an appropriate delta for most cases.
      var cleanDelta = 0.1;
      paths = ClipperLib.JS.Clean(paths, cleanDelta * scale);

      var miterLimit = 2;
      var arcTolerance = 0.25;
      var co = new ClipperLib.ClipperOffset(miterLimit, arcTolerance);

      co.AddPaths(
        paths,
        ClipperLib.JoinType.jtRound,
        ClipperLib.EndType.etClosedPolygon
      );
      var offsettedPaths = new ClipperLib.Paths();
      co.Execute(offsettedPaths, amount * scale);

      // Scale down coordinates and draw ...
      var pathString = this.paths2string(offsettedPaths, scale);
      if (pathString) {
        var inset = new paper.CompoundPath(pathString);
        inset.data = _.extend({}, inPath.data);
        inset.set({
          strokeColor: inPath.strokeColor,
          strokeWidth: inPath.strokeWidth,
          fillColor: inPath.fillColor
        });

        if (doReplace) {
          inPath.replaceWith(inset);
        } else {
          inPath.remove();
        }
        return inset;
      } else {
        inPath.remove();
        return false;
      }
    },

    /**
     * Convert a ClipperLib paths array into an SVG path string.
     * @param  {Array} paths
     *   A Nested ClipperLib Paths array of point objects
     * @param  {[type]} scale
     *   The amount to scale the values back down from.
     * @return {String}
     *   A properly formatted SVG path "d" string.
     */
    paths2string: function(paths, scale) {
      var svgpath = "", i, j;
      if (!scale) scale = 1;
      for(i = 0; i < paths.length; i++) {
        for(j = 0; j < paths[i].length; j++){
          if (!j) svgpath += "M";
          else svgpath += "L";
          svgpath += (paths[i][j].X / scale) + ", " + (paths[i][j].Y / scale);
        }
        svgpath += "Z";
      }
      return svgpath;
    },

    /**
     * Flatten a given Paper layer into technically non-overlapping
     * self-subtracted paths and compound paths.
     * @param  {Paper.Layer} layer
     *   Layer to work on. All children of the layer will be effected.
     *   Ensure no groups are in the layer before running this.
     * @return {undefined}
     *   Works directly on the layer and its children.
     */
    flattenSubtractLayer: function(layer) {
      var children = _.extend([], layer.children);
      for (var srcIndex = 0; srcIndex < children.length; srcIndex++) {
        var srcPath = children[srcIndex];

        // Ungroup any source child item before continuing.
        if (srcPath instanceof paper.Group) {
          var group = srcPath;
          group.remove(); // Remove from the layer.
          srcPath = group.removeChildren(1); // Set to child
        }

        srcPath.data.processed = true;

        // Replace this path with a subtract for every intersecting path,
        // starting at the current index (lower paths don't subtract from
        // higher ones)
        var tmpLen = layer.children.length;
        for (var destIndex = srcIndex; destIndex < tmpLen ; destIndex++) {
          var destPath = layer.children[destIndex];
          if (destIndex !== srcIndex) {
            var tmpPath = srcPath; // Hold onto the original path

            if (srcPath instanceof paper.Group) {
              var g = srcPath;
              g.remove(); // Remove from the layer.
              srcPath = g.removeChildren(1); // Set to child
            }

            // Dead path? we're done.
            if (srcPath.length === 0) {
              break;
            }

            // Set srcPath to the subtracted one inserted at the same index.
            srcPath = layer.insertChild(srcIndex, srcPath.subtract(destPath));
            srcPath.data = _.extend({}, tmpPath.data);

            tmpPath.remove(); // Remove the old srcPath
          }
        }
      }
    },

    /**
     * Destroy all "thin" fill paths/compounds on a given layer, removing or
     * replacing them with simplified approximations via competing offsets.
     * @param  {Paper.Layer}  layer
     *   Paper layer (or item with children) to apply to.
     * @param  {Number}  amount
     *   Amount to offset, represents the smallest feature to be absorbed.
     * @param  {Boolean} [clone=false]
     *   Whether to clone the input objects before running the process.
     */
    destroyThinFeatures: function(layer, amount, clone = false) {
      var resolution = 2; // Distance between each point during flattening.
      var items = _.extend([], layer.children);
      _.each(items, function(item) {
        var mask = clone ? item.clone() : item;
        mask = paper.utils.offsetPath(mask, -amount, resolution);

        // Only if there's a result from the destructive process above...
        if (mask) {
          // Then unoffset the same fill to use as a mask.
          mask = paper.utils.offsetPath(mask, amount, resolution);

          // Add the final object back into the layer.
          layer.addChild(mask);
        }
      });
    },

    /**
     * Move through every child in the given passed paper object and remove any
     * base level children with a path length less than a minimum.
     * @param  {Paper.*} item
     *   Paper object with at least one child, or item to be checked for length.
     * @param  {Number} minLength
     *   Minimum length, below which any path will be removed.
     */
    recursiveLengthCull: function(item, minLength) {
      // Bad item? Skip it.
      if (typeof item === 'undefined') {
        return;
      }

      // Parent or bottom level child?
      if (typeof item.children !== 'undefined') {
        if (item.children.length) {
          // Remember! If you mess with a parent's children, you must operate on
          // a copy of the array, otherwise it will shrink in front of you.
          var childList = _.extend([], item.children);
          _.each(childList, function(i) {
            paper.utils.recursiveLengthCull(i, minLength);
          });
        } else {
          // Empty parent level item.
          item.remove();
        }
      } else {
        // Bottom level child, cull if below length.
        if (item.length < minLength) {
          item.remove();
        }
      }
    },

    /**
     * Get Data URI of any rasterizable paper object.
     * @param  {Paper.*} item
     *   Any paper object that supports rasterization.
     * @param  {Number} dpi
     *   Resolution for intermediary rasterization.
     * @return {String}
     *   Data URI representing the PNG image of the object.
     */
    getDataURI: function(item, dpi = 72) {
      var tempRaster = item.rasterize(dpi);
      var dataURI = tempRaster.toDataURL();
      tempRaster.remove();
      return dataURI;
    },

    /**
     * Save a raster image directly as a local file (PNG).
     *
     * @param  {Paper.item} item
     *   Paper item (Group|Layer|Raster|Path|CompoundPath) object to be saved.
     * @param {Number} dpi
     *   DPI to rasterize to.
     * @param  {String} dest
     *   Destination file to be saved.
     * @return {Promise}
     *   Fulfilled promise returns final destination file path.
     */
    saveRasterImage: function(item, dpi, dest) {
      var exportRaster = item.rasterize(dpi);
      return new Promise(function(resolve, reject) {
        var b = canvasBuffer(exportRaster.canvas, 'image/png');
        fs.writeFile(dest, b, function(err) {
          exportRaster.remove();
          if (err) {
            reject(Error(err));
          } else {
            resolve(dest);
          }
        });
      });
    },

    snapColors: [], // Set via snapColorSetup below.

    /**
     * Reset and build out the snapColors array.
     * @param  {Array} colors
     *   Array of hexadecimal colors.
     */
    snapColorSetup: function(colors) {
      this.snapColors = [];
      var t = this;
      _.each(colors, function(color, index) {
        t.snapColors.push(t.renderColorData(color, 'color' + index));
      });
    },

    /**
     * Figure out what the center positions and scales should be for cloneCount
     * and the traced image dimensions.
     * @param  {Number} count
     *   Either 1, 2, 4, or 8.
     * @param  {Paper.Rectangle} traceBounds
     *   Boundry object of the size of the item to be placed.
     * @param  {Paper.Rectangle} griddleBounds
     *   Boundary of the area for an item to be placed.
     * @return {Object}
     *   Contains array of positions (in x,y array format) and scale key.
     */
    getDuplicationLayout: function(count, traceBounds, griddleBounds) {
      var out = {scale: 1, positions: []};
      if (!traceBounds.width) return out;

      var griddleAspect = griddleBounds.height / griddleBounds.width;
      var traceAspect = traceBounds.height / traceBounds.width;
      var landscape = traceAspect < griddleAspect;

      // Every cloned item has the same size regardless of count.
      var fillPercent;
      var q = {
        width: griddleBounds.width / 4,
        height: griddleBounds.height / 4
      };

      // How many?
      switch (count) {
        case 1: // 1 item, center, 80% fill.
          fillPercent = 80;
          out.positions = [[q.width * 2, q.height * 2]];
          break;
        case 2: // 2 items, 90% of 50% width/height. SBS or TB
          fillPercent = 50;

          if (landscape) { // SBS
            out.positions = [
              [q.width * 2, q.height],     // Center Top.
              [q.width * 2, q.height * 3], // Center Bottom.
            ];
          } else { // Top/Bottom
            out.positions = [
              [q.width, q.height * 2],     // Left Middle.
              [q.width * 3, q.height * 2], // Right Middle.
            ];
          }
          break;
        case 4: // 4 items, 92% of 25% width/height. Simple Quadrant
          fillPercent = 35;
          out.positions = [
            [q.width, q.height],         // Top Left.
            [q.width * 3, q.height],     // Top Right.
            [q.width, q.height * 3],     // Bottom Left.
            [q.width * 3, q.height * 3], // Bottom Right.
          ];
          break;
        case 8: // 8 items, 95% of 12.5% width/height. SBS or TB 4x grouping.
          fillPercent = 25;
          // Eighth measurement.
          var e = {width: q.width / 2, height: q.height / 2};

          if (landscape) { // SBS 4 rows of 2.
            out.positions = [
              [q.width, e.height],         // A Left.
              [q.width * 3, e.height],     // A Right.

              [q.width, e.height * 3],     // B Left.
              [q.width * 3, e.height * 3], // B Right.

              [q.width, e.height * 5],     // C Left.
              [q.width * 3, e.height * 5], // C Right.

              [q.width, e.height * 7],     // D Left.
              [q.width * 3, e.height * 7], // D Right.
            ];
          } else { // Top/Bottom 2 rows of 4.
            out.positions = [
              [e.width, q.height],         // Top Left a.
              [e.width * 3, q.height],     // Top Left b.
              [e.width * 5, q.height],     // Top Right a.
              [e.width * 7, q.height],     // Top Right b.

              [e.width, q.height * 3],     // Bottom Left a.
              [e.width * 3, q.height * 3], // Bottom Left b.
              [e.width * 5, q.height * 3], // Bottom Right a.
              [e.width * 7, q.height * 3], // Bottom Right b.
            ];
          }
          break;
      }

      fillPercent /= 100;
      var scale = {
        x: (griddleBounds.width * fillPercent) / traceBounds.width,
        y: (griddleBounds.height * fillPercent) / traceBounds.height
      };

      out.scale = (scale.x < scale.y ? scale.x : scale.y);
      return out;
    },

    /**
     * Converts an RGB color value to HSL. Conversion formula
     * adapted from http://en.wikipedia.org/wiki/HSL_color_space.
     * Assumes r, g, and b are contained in the set [0, 255] and
     * returns h, s, and l in the set [0, 1].
     *
     * @param {Array} color
     *   The RGB color to be converted
     * @return {Array}
     *   The HSL representation
     */
    rgbToHSL: function (color){
      if (!color) return false;

      var r = color[0] / 255;
      var g = color[1] / 255;
      var b = color[2] / 255;

      var max = Math.max(r, g, b), min = Math.min(r, g, b);
      var h, s, l = (max + min) / 2;

      if (max === min){
        h = s = 0; // achromatic
      }else{
        var d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch(max){
          case r:h = (g - b) / d + (g < b ? 6 : 0);break;
          case g:h = (b - r) / d + 2;break;
          case b:h = (r - g) / d + 4;break;
        }
        h /= 6;
      }

      return [h, s, l];
    },

    /**
     * Converts an RGB color value to YUV.
     *
     * @param {Array} color
     *   The RGB color array to be converted
     * @return {Array}
     *   The YUV representation
     */
    rgbToYUV: function(color) {
      if (!color) return false;

      var r = color[0];
      var g = color[1];
      var b = color[2];
      var y, u, v;

      y = r *  0.299000 + g *  0.587000 + b *  0.114000;
      u = r * -0.168736 + g * -0.331264 + b *  0.500000 + 128;
      v = r *  0.500000 + g * -0.418688 + b * -0.081312 + 128;

      y = Math.floor(y);
      u = Math.floor(u);
      v = Math.floor(v);

      return [y,u,v];
    },

    /**
     * Converts an RGB string to a HEX string.
     *
     * @param {String} rgb
     *   The RGB color string in the format "rgb(0,0,0)"
     * @return {String}
     *   The string of the converted color, EG "#000000"
     */
    rgbToHex: function(rgb) {
      var c = rgb.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
      function hex(x) {
        return ("0" + parseInt(x).toString(16)).slice(-2);
      }

      if (c) {
        return "#" + hex(c[1]) + hex(c[2]) + hex(c[3]);
      } else {
        return rgb;
      }
    },

    /**
     * Converts a jQuery rgb or hex color string to a proper array [r,g,b]
     *
     * @param {String} string
     *   The HTML/CSS color string in the format "rgb(0,0,0)" or "#000000"
     * @return {Array}
     *   The color in RGB array format: [0, 0, 0]
     */
    colorStringToArray: function(string) {
      // Quick sanity check
      if (typeof string !== 'string') {
        return null;
      }

      // If it's already RGB, use it!
      if (string.indexOf('rgb') !== -1){
        var color = string.slice(4, -1).split(',');

        _.each(color, function(c, i){
          color[i] = Number(c);
        });

        return color;
      } else if(string.indexOf('#') !== -1) {
        // Otherwise, parse the hex triplet
        // Expand shorthand form (e.g. "03F") to full form (e.g. "0033FF")
        var shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
        string = string.replace(shorthandRegex, function(m, r, g, b) {
          m = m;
          return r + r + g + g + b + b;
        });

        var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(string);
        return result ? [
          parseInt(result[1], 16),
          parseInt(result[2], 16),
          parseInt(result[3], 16)
        ] : null;
      } else {
        // If the string doesn't contain "#" or "rgb" then it's outta there!
        return null;
      }
    },

    /**
     * Render a color data object from a hexadecimal color value.
     * @param  {String} colorHEX
     *   Hexadecimal color input to be converted.
     * @param  {String} name
     *   Some key or identifier for the color.
     * @return {Object}
     *   Object of key and color data.
     */
    renderColorData: function(colorHEX, name) {
      var colorRGB = this.colorStringToArray(colorHEX);
      return {
        key: name,
        color: {
          HEX: colorHEX,
          RGB: colorRGB,
          HSL: this.rgbToHSL(colorRGB),
          YUV: this.rgbToYUV(colorRGB),
        }
      };
    },

    /**
     * Takes source color and matches it to the nearest color from "colors"
     *
     * @param {Array/String} source
     *   triplet array [r,g,b] or jQuery RGB string like "rgb(0,0,0)"
     * @param {Array} colors
     *   Array of colorset objects defining colors.
     * @param {Number} limit
     *   How many colors to limit to, cuts off darker shades.
     * @return {Number}
     *   The index in the colors array that best matches the incoming color, -1
     *   if white/background color is best match.
     */
    snapColor: function(source, limit){
      // Clone colors so we don't mess with the global colors
      var colors = _.extend([], this.snapColors);

      // If a limit given, slice the array to just that amount.
      if (limit) {
        colors = colors.slice(0, limit);
      }

      if (typeof source === 'string'){
        source = this.colorStringToArray(source);
      }

      // Assume source is white if null.
      if (source === null || isNaN(source[0])){
        source = this.colorStringToArray('#FFFFFF');
      }

      // Convert to YUV to better match human perception of colors
      source = this.rgbToYUV(source);

      var lowestIndex = 0;
      var lowestValue = 1000; // High value start is replaced immediately below
      var distance = 0;
      for (var i = 0; i < colors.length; i++){
        var c = colors[i].color.YUV;

        // Color distance finder
        distance = Math.sqrt(
          Math.pow(c[0] - source[0], 2) +
          Math.pow(c[1] - source[1], 2) +
          Math.pow(c[2] - source[2], 2)
        );

        // Lowest value (closest distance) wins!
        if (distance < lowestValue){
          lowestValue = distance;
          lowestIndex = i;
        }
      }

      return lowestIndex;
    },

    /**
     * Return whether the layer contains any groups at the top level
     * @param  {paper.Layer} layer
     *   Layer to check for top level groups.
     * @return {Boolean}
     *
     */
    layerContainsGroups: function (layer) {
      for(var i in layer.children) {
        if (layer.children[i] instanceof paper.Group) return true;
      }
      return false;
    },

    /**
     * Ungroup all groups within a layer recursively.
     * @param  {paper.Layer} layer
     *   Layer/group to resurse through.
     */
    ungroupAllGroups: function (layer) {
      // Remove all groups
      while(paper.utils.layerContainsGroups(layer)) {
        for(var i in layer.children) {
          var path = layer.children[i];
          if (path instanceof paper.Group) {
            path.parent.insertChildren(0, path.removeChildren());
            path.remove();
          }
        }
      }
    },

    /**
     * Fit a given object within the given view or object bounds, given a
     * fill percentage  between 0.1 and 1.
     * @param  {[type]} object
     *   Object to scale within view bounds.
     * @param  {[type]} view
     *   View or object with .bounds property to size against/fill inside of.
     * @param  {Number} [fillWidth=0.8]
     *   Width to fill to maximum percentage of available view bounds.
     * @param  {Number} [fillHeight=0.8]
     *   Height to fill to maximum percentage of available view bounds.
     * @return {Number}
     *   Float used to scale the object to fit within the view.
     */
    fitScale: function (object, view, fillWidth = 0.8, fillHeight = 0.8) {
      // Size object based on view scales.
      var scale = {
        x: (view.bounds.width * fillWidth) / object.bounds.width,
        y: (view.bounds.height * fillHeight) / object.bounds.height
      };

      // Use the smallest scale.
      scale = (scale.x < scale.y ? scale.x : scale.y);
      object.scale(scale);
      return scale;
    },

    /**
     * Snap colors for every path/item in a given layer.
     * @param {paper.Layer} layer
     *   Paper layer to effect.
     * @param {Number} limit
     *   How many colors to limit to, cuts off darker shades.
     * @param {Boolean} outline
     *   Outline every fill with a darker shade.
     */
    autoColor: function(layer, limit, outline = false) {
      var t = this;

      // If running darker shade outlines, force limit to one below shade limit)
      if (outline) {
        limit = t.snapColors.length - 1;
      }

      var outlines = [];
      _.each(layer.children, function(item) {
        var colorIndex = 0;

        // Match stroke color and set details.
        if (item.strokeColor) {
          colorIndex = t.snapColor(item.strokeColor.toCSS(), limit);
          item.strokeColor = t.snapColors[colorIndex].color.HEX;
          item.data.color = colorIndex;
        }

        // Match fill color and set details.
        if (item.fillColor) {
          colorIndex = t.snapColor(item.fillColor.toCSS(), limit);
          item.fillColor = t.snapColors[colorIndex].color.HEX;
          item.data.color = colorIndex;
          item.data.fill = true;

          // Add a darker outline.
          if (outline) {
            var outlineItem = item.clone({insert: false});
            outlineItem.strokeColor = t.snapColors[colorIndex + 1].color.HEX;
            outlineItem.strokeWidth = 5;
            outlineItem.fillColor = null;
            outlineItem.data.fill = false;
            outlineItem.data.color = colorIndex + 1;
            outlines.push(outlineItem);
          }
        }
      });

      // Add the outlines back on top of the layer if any.
      if (outlines.length) {
        layer.addChildren(outlines);
      }
    }
  };

  // Give the main object back to the parent module.
  return utils;
};
