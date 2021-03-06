
"use strict";

const assert = require('assert');
const esprima = require('esprima');
const fs = require('fs');

const {DepthCache} = require('./depth_cache');
const {StringTable, Encoder} = require('./encoder');
const ast = require('./ast');

function jsonStr(obj, pretty) {
    if (pretty) {
        return JSON.stringify(obj, "utf8", pretty);
    } else {
        return JSON.stringify(obj);
    }
}


function dump_lifted(js_str) {
    const raw_ast = esprima.parseScript(js_str, {});
    const lifted_ast = ast.NodeType.mustLiftObj(raw_ast);
    prePostWalk(lifted_ast, printVisitor);
}

function dump_type_sorted(js_str) {
    const raw_ast = esprima.parseScript(js_str, {});
    const lifted_ast = ast.NodeType.mustLiftObj(raw_ast);
    // Walk and print the AST.
    //prePostWalk(lifted_ast, printVisitor);

    // Make a type-sorted index of all the subtrees.
    const type_map = new Map();
    prePostWalk(lifted_ast, makeSortVisitor(type_map));

    // Walk each of those sorted by type and print them.
    for (let [type_name, node_set] of type_map.entries()) {
        console.log('#########');
        console.log(`###### TYPE ${type_name} ######`);
        console.log('#');
        for (let {node, attrs} of node_set) {
            console.log(` ==> Node ${attrs.number}`);
            prePostWalk(node, printVisitor);
        }
    }
}

function compress(js_str) {
    const result = [];
    const raw_ast = esprima.parseScript(js_str, {range: true, loc: true});
    const lifted_ast = ast.NodeType.mustLiftObj(raw_ast);
    lifted_ast.depthFirstNumber();
    // Walk and print the AST.
    //prePostWalk(lifted_ast, printVisitor);

    // TODO: fill string table.
    const string_table = new StringTable();
    prePostWalk(lifted_ast, makeStringTableVisitor(string_table));
    string_table.finish();

    const encoder = new Encoder();
    encoder.writeStringTable(string_table);

    // Make a type-sorted index of all the subtrees.
    prePostWalk(lifted_ast, makeCompressVisitor(encoder));
    encoder.dump();

    fs.writeFileSync("/tmp/COMPRESSED", encoder.byteArray());
}

function makeStringTableVisitor(string_table) {
    return function (when, node, attrs) {
        if (when != 'begin') {
            return;
        }
        assert(node && node.type);
        node.forEachField((field, name) => {
            string_table.addValueRecursive(field.value);
        });
    }
};

function makeCompressVisitor(encoder) {
    let depth_cache = new DepthCache();

    // This is a map of nodes to templates, so that
    // we add the template for the node to the dictionary
    // when 'ending' the subtree at a given node.
    let template_map = new Map();

    return function (when, node, attrs) {
        if (when == 'begin') {
            assert(node && node.type);

            console.log(`--- BEGIN ${node.summaryString()}`);

            // Search for matching entries
            // in the cache.
            const match = depth_cache.search(node.attrs.depth, node);
            if (!match.ref) {
                const children = [];
                // No prior subtree matches, write the node directly
                // then return.
                encoder.writeDirectNode(node);
                node.forEachChild((ch, nm) => {
                    if (Array.isArray(ch)) {
                        for (let i = 0; i < ch.length; i++) {
                            children.push({name: nm + '.' + i,
                                           child: ch[i]});
                        }
                    } else {
                        children.push({name: nm, child: ch});
                    }
                });
                return children;
            }
            const {ref, depth_delta, rev_i, prior_tree, prior_template,
                   benefit, cuts} = match;
            let {step_count, cut_count, template} = {};
            if (match.prior_template) {
                step_count = match.prior_template.step_count;
                cut_count = match.prior_template.cut_count;
            } else {
                step_count = match.step_count;
                cut_count = match.cut_count;
                template_map.set(node.attrs.number, match.template);
            }
            console.log(`${ref}: ${node.summaryString().replace(/ /g, '_')}` +
                        ` BENEFIT:${benefit}` +
                        ` s/c=${step_count}/${cut_count}`);
            const prior_depth = node.attrs.depth + depth_delta;
            if (prior_tree) {
                console.log(`        PRIOR ${prior_tree.summaryString()} - ` +
                            prior_tree.toString().replace(/\n/, '\n        '));
                encoder.writeSubtreeRef(depth_delta, rev_i, cuts.map(c => c.num));
                depth_cache.useSubtreeEntry(prior_depth, rev_i);
            } else {
                console.log(`        PRIOR ${prior_template.tree.summaryString()}` +
                            prior_template.tree.toString().replace(/\n/, '\n        '));
                encoder.writeTemplateRef(depth_delta, rev_i);
                depth_cache.useTemplateEntry(prior_depth, rev_i);
            }
            const children = [];
            cuts.forEach((cut, i) => {
                const {reason, cut_kind, num, subst} = cut;
                if (cut_kind === 'top') {
                    assert('node' in subst);
                    const type_name = subst.node.type.name;
                    console.log(`  #CUT Top[${i}]@${num} ${subst.node.summaryString()} - (${reason})`);
                    children.push({name:ref, child:subst.node});

                } else if (cut_kind == 'fields') {
                    assert('value_map' in subst);
                    assert('query_node' in subst);

                    console.log(`  #CUT AllFields[${i}]@${num} - (${reason})`);
                    subst.value_map.forEach((v, k) => {
                        const v_str = v.valueString();
                        console.log(`    * ${k}=${v_str}`);
                    });
                    encoder.writeFieldMap(subst.query_node, subst.value_map);

                } else if (cut_kind == 'children') {
                    assert('node' in subst);

                    console.log(`  #CUT AllChildren[${i}]@${num} - (${reason})`);
                    subst.node.forEachChild((child, name) => {
                        if (Array.isArray(child)) {
                            child.forEach((ch, i) => {
                                const nm = name + '.' + i;
                                console.log(`    * ${nm}=${ch.summaryString()}`);
                                children.push({name:nm, child:ch});
                            });
                        } else {
                            console.log(`    * ${name}=${child.summaryString()}`);
                            children.push({name, child});
                        }
                    });

                } else if (cut_kind == 'child_array') {
                    assert('node_array' in subst);
                    console.log(`  #CUT ChildArray[${i}]@${num} - ${reason}`);
                    subst.node_array.forEach((ch, i) => {
                        console.log(`    * ${ch.summaryString()}`);
                        children.push({name:'.' + i, child:ch});
                    });

                } else if (cut_kind == 'child') {
                    assert('node' in subst);
                    const type_name = subst.node ? subst.node.type.name : 'NULL';
                    const summaryStr = subst.node ? subst.node.summaryString() : 'NULL';
                    console.log(`  #CutChild[${i}]@${num} ${summaryStr} - (${reason})`);
                    children.push({name:ref, child:subst.node});

                } else {
                    throw new Error("Unknown cut_kind: " + cut_kind);
                }

                /*
                if (subst.value) {
                    const value_str = subst.value.valueString();
                    console.log(`  #CutField[${i}]@${num} ${value_str} (${reason})`);
                } else if (subst.value_map) {
                    console.log(`  #CutAllFields[${i}]@${num} - (${reason})`);
                    subst.value_map.forEach((v, k) => {
                        const v_str = v.valueString();
                        console.log(`    * ${k}=${v_str}`);
                    });
                    encoder.writeFieldMap(node, subst.value_map);
                } else if (subst.node) {
                    const type_name = subst.node.type.name;
                    console.log(`  #CutChild[${i}]@${num} ${subst.node.summaryString()} - (${reason})`);
                    children.push({name:ref, child:subst.node});
                } else if (subst.node_array) {
                    console.log(`  #CutChildArray[${i}]@${num} - ${reason}`);
                    children.push({name:ref, child:subst.node_array});
                    for (let i = 0; i < subst.node_array.length; i++) {
                        const node = subst.node_array[i];
                        const type_name = node.type.name;
                        console.log(`    ${i} => ${node.summaryString()}`);
                    }
                }
                */
            });
            return children;
        } else if (when == 'end') {
            console.log(`--- END ${node.summaryString()}`);
            assert(node && node.type);
            // Push the subtree after it's completed
            // emitting.
            depth_cache.pushTree(node.attrs.depth, node);

            // If a template was generated from
            // encoding this subtree, push that.
            const template = template_map.get(node.attrs.number);
            if (template) {
                depth_cache.pushTemplate(node.attrs.depth, template);
                template_map.delete(node.attrs.number);
            }
        }
    }
};

function makeSortVisitor(type_map) {
    return function (when, node, attrs) {
        if (when != 'begin') {
            return;
        }

        const name = node.type.name;
        if (!type_map.has(name)) {
            type_map.set(name, new Set());
        }

        type_map.get(name).add({node, attrs});
    }
};

function printVisitor(when, node, attrs) {
    const shelf = "    ".repeat(attrs.depth);
    const output = [];
    if (when == 'begin') {
        output.push(shelf, attrs.disp_name);
        output.push(": ", node.type.short_name);
        if (node.parentNode()) {
            const parent_name = node.parentNode().type.short_name;
            output.push(` @ ${parent_name}`);
        }
        if (node.numFields() > 0) {
            output.push("\n");
        }
        node.forEachField((field, name) => {
            let field_str = field.valueString();
            if (field_str.length > 10) {
                field_str = field_str.substr(0, 15) + '...';
            }
            output.push(shelf, "^ ");
            output.push(name, "=", field_str, "\n");
        });
    } else if (when == 'end') {
        if (node.numChildren() > 0) {
            output.push(shelf, "/", attrs.name, ": ", node.type.short_name);
        } else{
            output.push("\n");
        }
    } else if (when == 'empty_array') {
        output.push(shelf, attrs.name, " = [<empty>]", "\n");
    }
    const output_str = output.join("").replace(/\n$/, '');
    for (let line of output_str.split("\n")) {
        console.log("LINE: " + line);
    }
}

function prePostWalk(lifted_ast, cb) {
    const state = {number: 0};
    prePostWalkHelper(lifted_ast, cb, {
        parent: null,
        name: '<root>',
        disp_name: '<root>',
        depth: 0,
        number: state.number,
        _state: state
    });
}

function prePostWalkHelper(node, cb, attrs) {
    // Begin the current node.
    let children = cb('begin', node, attrs);
    if (children === false) {
        return false;
    }
    // No children returned, take direct children.
    if (!Array.isArray(children)) {
        children = [];
        node.forEachChild((child, name) => {
            if (Array.isArray(child)) {
                for (let i = 0; i < child.length; i++) {
                    children.push({ name: name + '.' + i,
                                    child: child[i] });
                }
            } else {
                children.push({name, child});
            }
        });
    }

    // Walk each of the children.
    for (let {name, child} of children) {
        const is_array = Array.isArray(child);
        const chs = is_array ? child : [child];

        const proto_child_attrs = {
            parent: node,
            name: name,
            disp_name: '',
            depth: attrs.depth + 1,
            number: 0,
            _state: attrs._state
        };

        if (is_array && chs.length == 0) {
            const child_attrs = {};
            Object.assign(child_attrs, proto_child_attrs);
            if (cb('empty_array', null, child_attrs) === false) {
                return false;
            }
            return;
        }

        let brk = false;
        chs.forEach((ch, i) => {
            if (brk) { return; }
            if (!ch) {
                // All array entries should be valid.
                assert(!is_array);
                return;
            }
            const number = ++attrs._state.number;
            const disp_name = name + (is_array ? '.' + i : '');
            const child_attrs = {};
            Object.assign(child_attrs, proto_child_attrs,
                          {disp_name, number});
            if (prePostWalkHelper(ch, cb, child_attrs) === false) {
                brk = true;
            }
        });
        if (brk) {
            return false;
        }
    }

    // End the current node.
    if (cb('end', node, attrs) === false) {
        return false;
    }
}

module.exports = { dump_lifted, dump_type_sorted, compress };
