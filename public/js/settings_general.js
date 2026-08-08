
$(document).ready(function () {
  $('button.leavetype-remove-btn').on('click', function(e){

    e.stopPropagation();

    // The confirmation is asked by public/js/confirm_actions.js, which reads
    // the same data-confirm-message attribute on the capture phase and stops
    // this handler from running at all when the answer is no. Asking here too
    // put the dialog up twice.

    var delete_form = $('#delete_leavetype_form');
    delete_form.attr('action', delete_form.attr('action') + $(this).attr('value') + '/');

    delete_form.submit();

    return false;
  });
});
