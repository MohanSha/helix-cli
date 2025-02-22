/*
 * Copyright 2018 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-disable */

// CONTENTS

function helix_wrap_action(main) {
  const { OpenWhiskAction } = require('@adobe/helix-pipeline');
  const { pipe } = require('MOD_PIPE');
  const { pre, before, after, replace } = require('MOD_PRE');

  // todo: move to helix-pipeline
  const CONTEXT_PROPS = ['error', 'request', 'content', 'response'];
  const CONTENT_PROPS = ['sources', 'body', 'mdast', 'sections', 'document', 'htast' ,'json', 'xml', 'meta', 'title', 'intro', 'image'];
  const REQUEST_PROPS =  ['url', 'path', 'pathInfo', 'rootPath', 'selector', 'extension', 'method', 'headers', 'params'];
  const RESPONSE_PROPS = ['status', 'body', 'hast', 'headers', 'document'];

  const filterObject = (obj, allowedProperties) => {
    if (!obj) {
      return;
    }
    Object.keys(obj).forEach((key) => {
      if (allowedProperties.indexOf(key) < 0) {
        delete obj[key];
      }
    })
  };

  const sanitizeContext = (context) => {
    filterObject(context, CONTEXT_PROPS);
    filterObject(context.content, CONTENT_PROPS);
    filterObject(context.request, REQUEST_PROPS);
    filterObject(context.response, RESPONSE_PROPS);
  };

  // this gets called by openwhisk
  return async function wrapped(params) {
    // this is the once function that will be installed in the pipeline
    async function once(context, action) {
      // calls the pre function and then the script's main.
      async function invoker(next) {
        const ret = await Promise.resolve(pre(context, action));
        const res = await Promise.resolve(next(ret || context, action));
        if (!context.response) {
          context.response = {};
        }
        if (typeof res === 'object') {
          // check for response from direct script
          if (res.response) {
            context.response = res.response;
          } else if (res.type) {
            context.response.hast = res;
          } else {
            context.response.document = res;
          }
        } else {
          context.response.body = String(res);
        }
        sanitizeContext(context);
        return context;
      }
      return invoker(main);
    }

    if (before) {
      once.before = before;
    }
    if (after) {
      once.after = after;
    }
    if (replace) {
      once.replace = replace;
    }
    return OpenWhiskAction.runPipeline(once, pipe, params);
  };
}

module.exports.main = helix_wrap_action(module.exports.main);
